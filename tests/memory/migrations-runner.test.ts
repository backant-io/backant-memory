import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { loadMigrations, runMigrations, MigrationFailedError } from "../../src/memory/migrations.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

function fresh(name = "mig") {
  tempDir = mkdtempSync(join(tmpdir(), `bm-${name}-`));
  return createClient({ url: `file:${join(tempDir, "mem.db")}` });
}

describe("runMigrations", () => {
  it("replays the whole chain on a fresh store and stamps ledger + memory_meta", async () => {
    const client = fresh();
    await runMigrations(client);

    const ledger = await client.execute("SELECT name, sha256 FROM schema_migrations ORDER BY name");
    expect(ledger.rows.map((r) => r.name)).toEqual(loadMigrations().map((m) => m.name));
    expect(ledger.rows.map((r) => r.sha256)).toEqual(loadMigrations().map((m) => m.sha256));

    const stamp = await client.execute("SELECT value FROM memory_meta WHERE key='schema_version'");
    expect(stamp.rows[0].value).toBe(loadMigrations().at(-1)!.name);

    // The baseline actually ran: core tables exist.
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const names = tables.rows.map((r) => r.name);
    expect(names).toContain("memory");
    expect(names).toContain("memory_meta");
    expect(names).toContain("schema_migrations");
    client.close();
  });

  it("is idempotent — a second run applies nothing and leaves one ledger row per migration", async () => {
    const client = fresh();
    await runMigrations(client);
    const first = await client.execute("SELECT applied_at FROM schema_migrations WHERE name='000-baseline'");
    await runMigrations(client);
    const after = await client.execute("SELECT name, applied_at FROM schema_migrations");
    expect(after.rows.length).toBe(loadMigrations().length);
    expect(after.rows[0].applied_at).toBe(first.rows[0].applied_at); // not re-stamped
    client.close();
  });

  it("applies only the migrations the store is missing", async () => {
    const client = fresh();
    const chain = loadMigrations();
    await runMigrations(client, chain);

    // Append a synthetic migration and re-run: only the new one is applied.
    const extraDir = join(tempDir, "extra");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, "900-probe.sql"), "CREATE TABLE probe_marker (id INTEGER PRIMARY KEY);\n");
    const extended = [...chain, ...loadMigrations(extraDir)];
    await runMigrations(client, extended);

    const ledger = await client.execute("SELECT name FROM schema_migrations ORDER BY name");
    expect(ledger.rows.map((r) => r.name)).toEqual([...chain.map((m) => m.name), "900-probe"]);
    const stamp = await client.execute("SELECT value FROM memory_meta WHERE key='schema_version'");
    expect(stamp.rows[0].value).toBe("900-probe");
    client.close();
  });

  it("rolls back and throws naming the migration when one fails", async () => {
    const client = fresh();
    const chain = loadMigrations();
    const badDir = join(tempDir, "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "901-broken.sql"), "THIS IS NOT SQL;\n");
    const bad = [...chain, ...loadMigrations(badDir)];

    await expect(runMigrations(client, bad)).rejects.toThrow(MigrationFailedError);
    await expect(runMigrations(client, bad)).rejects.toThrow(/901-broken/);

    // No partial stamp: the ledger has no row for the broken migration, and
    // because the whole batch rolled back, nothing at all was stamped.
    const ledger = await client.execute(
      "SELECT name FROM schema_migrations WHERE name='901-broken'"
    );
    expect(ledger.rows.length).toBe(0);
    client.close();
  });

  it("retries the ledger bootstrap when a peer already holds the write lock", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-bootstrap-"));
    const path = join(tempDir, "mem.db");
    const peer = createClient({ url: `file:${path}` });
    const runner = createClient({ url: `file:${path}` });

    // A concurrent runner holds a write transaction for the whole batch — so the
    // FIRST statement we issue (the ledger bootstrap DDL, before any transaction
    // of our own) meets SQLITE_BUSY. Race safety has to cover that statement too,
    // otherwise the second runner dies on a lock it was always going to see.
    const held = await peer.transaction("write");
    await held.execute("CREATE TABLE peer_lock (x INTEGER)");
    const release = (async () => {
      await new Promise((r) => setTimeout(r, 80));
      await held.rollback();
    })();

    await runMigrations(runner);
    await release;

    const ledger = await runner.execute("SELECT name FROM schema_migrations ORDER BY name");
    expect(ledger.rows.map((r) => r.name)).toEqual(loadMigrations().map((m) => m.name));
    held.close();
    peer.close();
    runner.close();
  });

  it("survives concurrent runners against the same file (one applies, the rest no-op)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-race-"));
    const path = join(tempDir, "mem.db");
    const clients = [0, 1, 2, 3].map(() => createClient({ url: `file:${path}` }));
    await Promise.all(clients.map((c) => runMigrations(c)));
    const ledger = await clients[0].execute("SELECT name FROM schema_migrations");
    expect(ledger.rows.length).toBe(loadMigrations().length);
    clients.forEach((c) => c.close());
  });
});

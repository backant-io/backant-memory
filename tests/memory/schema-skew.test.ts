import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import type { TransactionMode } from "@libsql/client";
import { loadMigrations, runMigrations, SchemaSkewError } from "../../src/memory/migrations.js";
import { openMemoryDb } from "../../src/memory/libsql-db.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("schema skew guard", () => {
  it("refuses a store stamped with a migration this engine does not ship", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-skew-"));
    const client = createClient({ url: `file:${join(tempDir, "mem.db")}` });
    await runMigrations(client); // bring it to the engine's chain

    // Simulate a NEWER engine having migrated this store.
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
      args: ["999-from-the-future", "deadbeef", new Date().toISOString()],
    });
    await client.execute(
      "UPDATE memory_meta SET value='999-from-the-future' WHERE key='schema_version'"
    );

    await expect(runMigrations(client)).rejects.toThrow(SchemaSkewError);
    client.close();
  });

  it("names both versions and the upgrade hint in the message", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-skew-msg-"));
    const client = createClient({ url: `file:${join(tempDir, "mem.db")}` });
    await runMigrations(client);
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
      args: ["999-from-the-future", "deadbeef", new Date().toISOString()],
    });

    const err = await runMigrations(client).catch((e) => e as SchemaSkewError);
    expect(err).toBeInstanceOf(SchemaSkewError);
    expect(err.storeVersion).toBe("999-from-the-future");
    expect(err.engineVersion).toBe(loadMigrations().at(-1)!.name);
    expect(err.message).toContain("999-from-the-future");
    expect(err.message).toContain(loadMigrations().at(-1)!.name);
    expect(err.message).toContain("npm install -g backant-memory@latest");
    client.close();
  });

  it("a store BEHIND the engine is migrated forward, not refused", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-behind-"));
    const client = createClient({ url: `file:${join(tempDir, "mem.db")}` });
    // Apply nothing: an empty ledger is "behind" by the whole chain.
    await runMigrations(client);
    const ledger = await client.execute("SELECT name FROM schema_migrations");
    expect(ledger.rows.length).toBe(loadMigrations().length);
    client.close();
  });

  /**
   * The pre-lock read is a snapshot taken before anybody holds the write lock,
   * so a newer engine that wins the lock in between leaves this runner deciding
   * on stale facts. Guarding only that snapshot means the loser of the race sees
   * pending=[], returns SUCCESS, and goes on to write a store a newer engine
   * owns — the exact corruption the refusal exists to prevent. So the guard has
   * to run again on the set read UNDER the lock, which is the only set that is
   * still true at the moment the decision is made.
   *
   * Staging (deterministic, no sleeps): the ledger is pre-created and EMPTY, so
   * the pre-lock read finds nothing unknown (guard passes) and the whole chain
   * pending (so the runner must go take the lock). The newer engine's migration
   * is injected inside the client's `transaction()` call — the single seam
   * between the two reads — which lands it squarely in the TOCTOU window.
   */
  it("refuses when a newer engine wins the lock between the pre-lock read and the re-read", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-skew-toctou-"));
    const path = join(tempDir, "mem.db");

    const futureDir = join(tempDir, "future");
    mkdirSync(futureDir, { recursive: true });
    writeFileSync(
      join(futureDir, "999-from-the-future.sql"),
      "CREATE TABLE from_the_future (id INTEGER PRIMARY KEY);\n"
    );
    const newerChain = [...loadMigrations(), ...loadMigrations(futureDir)];

    const client = createClient({ url: `file:${path}` });
    // Ledger present but empty: bootstrapLedger reads it instead of creating it,
    // so the only transaction() this runner opens is the migration batch itself.
    await client.execute(
      "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)"
    );

    const peer = createClient({ url: `file:${path}` });
    let raced = false;
    const interleaved = new Proxy(client, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (mode?: TransactionMode) => {
            if (!raced) {
              raced = true;
              // Engine B ships one migration more and gets the lock first.
              await runMigrations(peer, newerChain);
            }
            return target.transaction(mode);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(runMigrations(interleaved, loadMigrations())).rejects.toThrow(SchemaSkewError);
    expect(raced).toBe(true); // the interleave really happened

    // The loser wrote nothing: the newer engine's ledger is exactly as it left it.
    const ledger = await client.execute("SELECT name FROM schema_migrations ORDER BY name");
    expect(ledger.rows.map((r) => r.name)).toEqual(newerChain.map((m) => m.name));

    client.close();
    peer.close();
  });

  // The refusal only protects users if it reaches them: openMemoryDb is the one
  // door every caller goes through, so the throw must cross that seam rather
  // than be caught and downgraded to "opened anyway". Swallowing it there would
  // let an old engine write a store a newer one owns — silent corruption.
  it("openMemoryDb propagates the refusal instead of opening the store", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-skew-open-"));
    const path = join(tempDir, "mem.db");
    const first = await openMemoryDb({ localPath: path });
    await first.close();

    const client = createClient({ url: `file:${path}` });
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
      args: ["999-from-the-future", "deadbeef", new Date().toISOString()],
    });
    client.close();

    await expect(openMemoryDb({ localPath: path })).rejects.toThrow(SchemaSkewError);
  });
});

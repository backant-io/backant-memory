import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import {
  loadMigrations,
  runMigrations,
  MigrationFailedError,
} from "../../src/memory/migrations.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

/** A store as it existed before per-repo scoping and the Memory v2 columns. */
async function makePreVersionedStore(path: string): Promise<void> {
  const raw = createClient({ url: `file:${path}` });
  await raw.execute(
    `CREATE TABLE memory (
      id TEXT PRIMARY KEY, tier TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
      sources TEXT NOT NULL, weight REAL NOT NULL, created TEXT NOT NULL,
      last_reinforced TEXT NOT NULL, dream_citations INTEGER NOT NULL DEFAULT 0,
      act_citations INTEGER NOT NULL DEFAULT 0, revision_count INTEGER NOT NULL DEFAULT 0,
      embedding BLOB)`
  );
  await raw.execute(
    `INSERT INTO memory (id,tier,type,content,sources,weight,created,last_reinforced)
     VALUES ('legacy-1','ltm','fact','survives','[]',1.0,'2026-01-01','2026-01-01')`
  );
  raw.close();
}

describe("pre-versioning store normalization", () => {
  it("adds the repo + Memory v2 columns, then stamps at the head of the chain", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-legacy-"));
    const path = join(tempDir, "old.db");
    await makePreVersionedStore(path);

    const client = createClient({ url: `file:${path}` });
    await runMigrations(client);

    const cols = (await client.execute("PRAGMA table_info(memory)")).rows.map((r) => String(r.name));
    expect(cols).toContain("repo");
    expect(cols).toContain("verdict_boost");
    expect(cols).toContain("valid_from");
    expect(cols).toContain("valid_to");

    const ledger = await client.execute("SELECT name FROM schema_migrations ORDER BY name");
    expect(ledger.rows.map((r) => r.name)).toEqual(loadMigrations().map((m) => m.name));

    const stamp = await client.execute("SELECT value FROM memory_meta WHERE key='schema_version'");
    expect(stamp.rows[0].value).toBe(loadMigrations().at(-1)!.name);
    client.close();
  });

  it("preserves existing rows (normalization is additive, never destructive)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-legacy-rows-"));
    const path = join(tempDir, "old.db");
    await makePreVersionedStore(path);

    const client = createClient({ url: `file:${path}` });
    await runMigrations(client);
    const row = await client.execute("SELECT content, repo FROM memory WHERE id='legacy-1'");
    expect(row.rows[0].content).toBe("survives");
    expect(row.rows[0].repo).toBe(""); // NOT NULL DEFAULT ''
    client.close();
  });

  it("does not re-run normalization on an already-stamped store", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-legacy-twice-"));
    const path = join(tempDir, "old.db");
    await makePreVersionedStore(path);

    const client = createClient({ url: `file:${path}` });
    await runMigrations(client);
    await runMigrations(client); // second open must be a clean no-op
    const cols = (await client.execute("PRAGMA table_info(memory)")).rows.map((r) => String(r.name));
    expect(cols.filter((c) => c === "repo").length).toBe(1);
    client.close();
  });

  it("skips normalization when the ledger is NOT empty, even on a legacy-shaped store", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-legacy-gate-"));
    const path = join(tempDir, "old.db");
    await makePreVersionedStore(path);

    // A ledger with any row in it means some engine already owns this store's
    // shape; normalization is a pre-versioning affair and must not fire again.
    const client = createClient({ url: `file:${path}` });
    await client.execute(
      "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)"
    );
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, sha256, applied_at) VALUES (?, ?, ?)",
      args: ["000-already", "sha-already", "2026-01-01T00:00:00.000Z"],
    });

    // The injected chain leaves one migration PENDING, which is what drives the
    // runner past its up-to-date early return and into the transaction — so
    // control genuinely reaches the ledger-empty gate rather than skipping it.
    await runMigrations(client, [
      { name: "000-already", sql: "SELECT 1", sha256: "sha-already" },
      {
        name: "001-pending",
        sql: "CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        sha256: "sha-pending",
      },
    ]);

    const applied = await client.execute("SELECT name FROM schema_migrations ORDER BY name");
    expect(applied.rows.map((r) => r.name)).toEqual(["000-already", "001-pending"]); // it ran
    const cols = (await client.execute("PRAGMA table_info(memory)")).rows.map((r) => String(r.name));
    expect(cols).not.toContain("repo"); // …and normalization did not
    client.close();
  });

  it("rolls the normalization back with the batch when a later migration fails", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-legacy-rollback-"));
    const path = join(tempDir, "old.db");
    await makePreVersionedStore(path);

    const client = createClient({ url: `file:${path}` });
    const chain = [
      ...loadMigrations(),
      { name: "001-bad", sql: "THIS IS NOT SQL;", sha256: "sha-bad" },
    ];
    await expect(runMigrations(client, chain)).rejects.toThrow(MigrationFailedError);

    // The ALTERs run on the migration's own transaction, so the failure took
    // them down with it. Run them on the client before BEGIN — the shape the
    // retired upgradeOlderSchema had — and this store would keep a `repo`
    // column that no ledger row accounts for.
    const cols = (await client.execute("PRAGMA table_info(memory)")).rows.map((r) => String(r.name));
    expect(cols).not.toContain("repo");
    const ledger = await client.execute("SELECT name FROM schema_migrations");
    expect(ledger.rows.length).toBe(0);
    client.close();
  });
});

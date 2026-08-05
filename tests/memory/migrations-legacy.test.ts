import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { loadMigrations, runMigrations } from "../../src/memory/migrations.js";

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
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { openMemoryDb } from "../../src/memory/libsql-db.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("verdict_boost column (shipped by Plan 0 Task A2 — Plan 2 prerequisite)", () => {
  it("PREREQUISITE: memory.verdict_boost exists — Plan 0 owns this migration", async () => {
    // Plan 0 Task A2 owns this migration — do not re-add the column; stop and
    // land Plan 0 first if this assertion fails.
    tempDir = mkdtempSync(join(tmpdir(), "kairos-vb-prereq-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    const cols = await db.all<{ name: string }>("PRAGMA table_info(memory)");
    const names = cols.map((c) => c.name);
    expect(
      names,
      "memory.verdict_boost is missing. Plan 0 Task A2 owns this migration — " +
        "do not re-add the column in Plan 2; stop and land Plan 0 first."
    ).toContain("verdict_boost");
    await db.close();
  });

  it("exists on a fresh store with default 0 (Plan 0 migration regression)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-vb-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await db.run(
      `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
       VALUES ('m1','o/r','stm','observation','x','[]',1.0,'2026-01-01','2026-01-01')`
    );
    const row = await db.get<{ verdict_boost: number }>("SELECT verdict_boost FROM memory WHERE id='m1'");
    expect(Number(row?.verdict_boost)).toBe(0);
    await db.close();
  });

  it("is present in place on an older store that opened pre-migration (legacy-normalization regression)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-vb-old-"));
    const path = join(tempDir, "old.db");
    // Build a store WITHOUT verdict_boost, mimicking a pre-Plan-0 db, then open
    // it through openMemoryDb so the migration runner's pre-versioning
    // normalization does the in-place add before the baseline migration.
    const raw = createClient({ url: `file:${path}` });
    await raw.execute(
      `CREATE TABLE memory (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL, weight REAL NOT NULL,
        created TEXT NOT NULL, last_reinforced TEXT NOT NULL,
        dream_citations INTEGER NOT NULL DEFAULT 0, act_citations INTEGER NOT NULL DEFAULT 0,
        revision_count INTEGER NOT NULL DEFAULT 0, embedding BLOB)`
    );
    raw.close();

    const db = await openMemoryDb({ localPath: path });
    const cols = await db.all<{ name: string }>("PRAGMA table_info(memory)");
    expect(cols.map((c) => c.name)).toContain("verdict_boost");
    await db.close();
  });

  it("UPDATE of verdict_boost bumps change_seq (cache-invalidation proof)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-vb-seq-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await db.run(
      `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
       VALUES ('m1','o/r','stm','observation','x','[]',1.0,'2026-01-01','2026-01-01')`
    );
    const before = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id=1");
    await db.run("UPDATE memory SET verdict_boost = verdict_boost + 1 WHERE id='m1'");
    const after = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id=1");
    expect(Number(after?.s)).toBe(Number(before?.s) + 1);
    await db.close();
  });
});

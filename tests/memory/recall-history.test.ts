import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import { recallAsOf } from "../../src/memory/recall-history.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function open() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-asof-"));
  return openMemoryDb({ localPath: join(tempDir, ".index.db") });
}

async function ins(db: any, id: string, content: string, created: string, validTo: string | null) {
  await db.batch([
    {
      sql: `INSERT INTO memory (id, repo, tier, type, content, sources, weight, created, last_reinforced, valid_to)
            VALUES (?, '', 'ltm', 'lesson', ?, '[]', 1, ?, ?, ?)`,
      args: [id, content, created, created, validTo],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [id, content],
    },
  ]);
}

describe("recallAsOf", () => {
  it("returns rows valid at the as-of instant: created before, not yet invalidated", async () => {
    const db = await open();
    // belief1: created 03-01, superseded 05-01 → valid at 04-01, NOT at 06-01
    await ins(db, "belief1", "auth uses sessions", "2026-03-01T00:00:00Z", "2026-05-01T00:00:00Z");
    // belief2: created 05-01, still valid → NOT at 04-01, valid at 06-01
    await ins(db, "belief2", "auth uses tokens", "2026-05-01T00:00:00Z", null);

    const atApril = await recallAsOf({ db, cue: "auth", asOf: "2026-04-01T00:00:00Z" });
    expect(atApril.map((r) => r.id)).toEqual(["belief1"]);

    const atJune = await recallAsOf({ db, cue: "auth", asOf: "2026-06-01T00:00:00Z" });
    expect(atJune.map((r) => r.id)).toEqual(["belief2"]);
  });

  it("excludes rows created after the as-of instant", async () => {
    const db = await open();
    await ins(db, "future", "not yet known", "2026-09-01T00:00:00Z", null);
    const r = await recallAsOf({ db, cue: "known", asOf: "2026-06-01T00:00:00Z" });
    expect(r).toHaveLength(0);
  });

  it("does not dump the corpus when the cue has no indexable (3+ char) token", async () => {
    const db = await open();
    // A row that is valid at the as-of instant but unrelated to the short cue.
    await ins(db, "valid1", "auth uses tokens", "2026-05-01T00:00:00Z", null);
    // "DB" is a 2-char cue; after stripping it yields no 3+ char token. The
    // interval predicate alone would otherwise return every valid row.
    const r = await recallAsOf({ db, cue: "DB", asOf: "2026-06-01T00:00:00Z" });
    expect(r).toHaveLength(0);
  });
});

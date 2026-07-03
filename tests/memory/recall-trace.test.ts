import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import { buildTraceResults, type ScoredHit } from "../../src/memory/recall-trace.js";
import { sweepRecallTraces } from "../../src/memory/recall-trace.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function open() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-trace-"));
  return openMemoryDb({ localPath: join(tempDir, ".index.db") });
}

describe("recall_trace schema", () => {
  it("creates the recall_trace table with the consolidated DDL columns", async () => {
    const db = await open();
    const cols = await db.all<{ name: string }>("PRAGMA table_info(recall_trace)");
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ["caller", "cue", "cycle_id", "filters", "id", "k", "miss", "misses", "repo", "results", "timestamp"].sort()
    );
  });

  it("inserting a recall_trace row does NOT bump memory change_seq", async () => {
    const db = await open();
    const before = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id = 1");
    await db.run(
      `INSERT INTO recall_trace (repo, cycle_id, caller, cue, k, filters, results, misses, miss, timestamp)
       VALUES ('', 'c1', 'judge', 'cue', 10, '{}', '[]', '[]', 0, ?)`,
      [new Date().toISOString()]
    );
    const after = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id = 1");
    expect(Number(after?.s)).toBe(Number(before?.s));
  });
});

describe("additive memory columns", () => {
  it("memory has verdict_boost defaulting to 0 and nullable valid_from/valid_to", async () => {
    const db = await open();
    const cols = await db.all<{ name: string; dflt_value: string | null; notnull: number }>(
      "PRAGMA table_info(memory)"
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("verdict_boost")).toBe(true);
    expect(Number(byName.get("verdict_boost")!.dflt_value)).toBe(0);
    expect(byName.has("valid_from")).toBe(true);
    expect(byName.has("valid_to")).toBe(true);
    // valid_from/valid_to are nullable (NULL = created / currently valid)
    expect(byName.get("valid_from")!.notnull).toBe(0);
    expect(byName.get("valid_to")!.notnull).toBe(0);
  });
});

describe("additive memory columns — in-place upgrade of a v1.3 store", () => {
  // The fresh-create test above only hits schema.sql's CREATE TABLE path. A
  // real v1.3 store predates verdict_boost/valid_from/valid_to, so opening it
  // must run upgradeOlderSchema's ALTER branch — the stated point of Task A2
  // ("later layers need no second migration"). These tests seed that older
  // shape and reopen, so the migration path itself is exercised.
  const V2_COLS = ["verdict_boost", "valid_from", "valid_to"] as const;

  // A v1.3-shaped memory table: post per-repo scoping, but before the Memory v2
  // additive columns. Created directly (bypassing schema.sql) so reopening it
  // forces the in-place ADD COLUMN path rather than CREATE TABLE IF NOT EXISTS.
  async function seedV1_3Memory(path: string): Promise<void> {
    const c = createClient({ url: `file:${path}` });
    await c.execute(`CREATE TABLE memory (
      id              TEXT PRIMARY KEY,
      repo            TEXT NOT NULL DEFAULT '',
      tier            TEXT NOT NULL CHECK (tier IN ('stm','ltm')),
      type            TEXT NOT NULL,
      content         TEXT NOT NULL,
      sources         TEXT NOT NULL,
      weight          REAL NOT NULL,
      created         TEXT NOT NULL,
      last_reinforced TEXT NOT NULL,
      dream_citations INTEGER NOT NULL DEFAULT 0,
      act_citations   INTEGER NOT NULL DEFAULT 0,
      revision_count  INTEGER NOT NULL DEFAULT 0,
      embedding       BLOB
    )`);
    await c.execute({
      sql: `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      args: ["old1", "o/r", "ltm", "fact", "pre-v2 row", "[]", 1.0, "t", "t"],
    });
    c.close();
  }

  function makePath(): string {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mig-"));
    return join(tempDir, ".index.db");
  }

  it("adds verdict_boost/valid_from/valid_to to a pre-v2 memory table on open", async () => {
    const path = makePath();
    await seedV1_3Memory(path);
    // Sanity: the seeded store genuinely lacks the v2 columns.
    const seed = createClient({ url: `file:${path}` });
    const pre = (await seed.execute("PRAGMA table_info(memory)")).rows.map((r) => r.name);
    seed.close();
    for (const col of V2_COLS) expect(pre).not.toContain(col);

    const db = await openMemoryDb({ localPath: path });
    const cols = await db.all<{ name: string; dflt_value: string | null; notnull: number }>(
      "PRAGMA table_info(memory)"
    );
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("verdict_boost")).toBe(true);
    expect(Number(byName.get("verdict_boost")!.dflt_value)).toBe(0);
    expect(byName.get("valid_from")!.notnull).toBe(0);
    expect(byName.get("valid_to")!.notnull).toBe(0);
    // The migration is in-place: the pre-existing row survives, with the new
    // NOT NULL column taking its default and the nullable ones NULL.
    const row = await db.get<{ verdict_boost: number; valid_from: string | null }>(
      "SELECT verdict_boost, valid_from FROM memory WHERE id = 'old1'"
    );
    expect(Number(row?.verdict_boost)).toBe(0);
    expect(row?.valid_from).toBeNull();
    await db.close();
  });

  it("is a no-op on the second open (migration is idempotent)", async () => {
    const path = makePath();
    await seedV1_3Memory(path);
    const db1 = await openMemoryDb({ localPath: path });
    await db1.close();
    // Reopening an already-migrated store must not re-run the ALTERs (a second
    // ADD COLUMN would throw "duplicate column"); the data must be untouched.
    const db2 = await openMemoryDb({ localPath: path });
    const cols = await db2.all<{ name: string }>("PRAGMA table_info(memory)");
    const names = cols.map((c) => c.name);
    for (const col of V2_COLS) expect(names).toContain(col);
    const cnt = await db2.get<{ c: number }>("SELECT COUNT(*) c FROM memory");
    expect(Number(cnt?.c)).toBe(1);
    await db2.close();
  });

  it("rolls back every added column if any migration ALTER fails (transactional)", async () => {
    // Spec §Error handling: the additive migration is transactional — on
    // failure the store stays v1.3-compatible, never half-migrated. Drive the
    // same atomic primitive upgradeOlderSchema uses (batch(..., "write")) with
    // the real migration ALTERs plus a poison statement, and assert the table
    // is left exactly at its pre-migration shape (no partial column adds).
    const path = makePath();
    await seedV1_3Memory(path);
    const c = createClient({ url: `file:${path}` });
    const before = (await c.execute("PRAGMA table_info(memory)")).rows.map((r) => r.name);
    await expect(
      c.batch(
        [
          "ALTER TABLE memory ADD COLUMN verdict_boost REAL NOT NULL DEFAULT 0",
          "ALTER TABLE memory ADD COLUMN valid_from TEXT",
          "ALTER TABLE memory ADD COLUMN valid_to TEXT",
          "ALTER TABLE memory ADD COLUMN this is not valid sql", // forces abort
        ],
        "write"
      )
    ).rejects.toThrow();
    const after = (await c.execute("PRAGMA table_info(memory)")).rows.map((r) => r.name);
    c.close();
    expect(after).toEqual(before);
    for (const col of V2_COLS) expect(after).not.toContain(col);
  });
});

describe("buildTraceResults", () => {
  function hit(id: string, rank: number): ScoredHit {
    return {
      id, content: id, weight: 0.5, type: "lesson", tier: "ltm", sources: [],
      score: 1 - rank * 0.01,
      breakdown: { bm25: 0.4, cos: 0.3, weight: 0.05, recency: 0.05, verdict: 0 },
    };
  }

  it("serializes top-k as results with rank+injected, near-misses as ranks k+1..k+10", () => {
    const ranked: ScoredHit[] = Array.from({ length: 25 }, (_, i) => hit(`m${i}`, i + 1));
    const { results, misses } = buildTraceResults(ranked, 10);
    expect(results).toHaveLength(10);
    expect(results[0]).toMatchObject({ id: "m0", rank: 1, injected: true });
    expect(results[0].breakdown).toEqual({ bm25: 0.4, cos: 0.3, weight: 0.05, recency: 0.05, verdict: 0 });
    // near-misses are ranks 11..20 (k+1..k+10)
    expect(misses).toHaveLength(10);
    expect(misses[0]).toMatchObject({ id: "m10", rank: 11, injected: false });
    expect(misses[9]).toMatchObject({ id: "m19", rank: 20 });
  });

  it("caps near-misses at whatever ranked rows exist below k", () => {
    const ranked: ScoredHit[] = Array.from({ length: 13 }, (_, i) => hit(`m${i}`, i + 1));
    const { results, misses } = buildTraceResults(ranked, 10);
    expect(results).toHaveLength(10);
    expect(misses).toHaveLength(3); // only ranks 11,12,13 exist
  });
});

describe("sweepRecallTraces", () => {
  it("deletes only rows older than 30 days", async () => {
    const db = await open();
    const now = new Date("2026-06-11T00:00:00Z");
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    for (const ts of [old, recent]) {
      await db.run(
        `INSERT INTO recall_trace (repo, cycle_id, caller, cue, k, filters, results, misses, miss, timestamp)
         VALUES ('', 'c', 'judge', 'q', 10, '{}', '[]', '[]', 0, ?)`,
        [ts]
      );
    }
    const r = await sweepRecallTraces({ db, now: () => now });
    expect(r.deleted_n).toBe(1);
    const left = await db.all<{ timestamp: string }>("SELECT timestamp FROM recall_trace");
    expect(left).toHaveLength(1);
    expect(left[0].timestamp).toBe(recent);
  });
});

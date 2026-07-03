import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { reinforce } from "../../../src/tools/memory/reinforce.js";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

const fakeEmbedder = {
  async embed(text: string) {
    const v = new Float32Array(4);
    for (let i = 0; i < text.length; i++) v[i % 4] += (text.charCodeAt(i) % 13) / 10;
    return v;
  },
} as never as import("../../../src/ollama/embeddings.js").Embedder;

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
  const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
  return { db, embedder: fakeEmbedder };
}

describe("reinforce", () => {
  it("multiplies weight by factor and caps at 1.0", async () => {
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    const r = await reinforce({ db, id: e.id, factor: 1.5, reason: "act-cite" });
    expect(r.new_weight).toBe(1.0);
    expect(r.id).toBe(e.id);
    await db.close();
  });

  it("clamps weight to floor 0.0 when factor < 1", async () => {
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    await reinforce({ db, id: e.id, factor: 0.5, reason: "decay" });
    const r2 = await reinforce({ db, id: e.id, factor: 0.0, reason: "wipe" });
    expect(r2.new_weight).toBe(0.0);
    await db.close();
  });

  it("increments dream_citations when reason='dream-cite'", async () => {
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    await reinforce({ db, id: e.id, factor: 1.2, reason: "dream-cite" });
    const row = await db.get<any>("SELECT * FROM memory WHERE id = ?", [e.id]);
    expect(Number(row.dream_citations)).toBe(1);
    await db.close();
  });

  it("increments act_citations when reason='act-cite'", async () => {
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    await reinforce({ db, id: e.id, factor: 1.5, reason: "act-cite" });
    const row = await db.get<any>("SELECT * FROM memory WHERE id = ?", [e.id]);
    expect(Number(row.act_citations)).toBe(1);
    await db.close();
  });

  // verdict_boost is the additive ranking signal the recall fusion weights at
  // W_VERDICT=0.05. The ONLY production producer of that signal is a citation:
  // a dream verdict (dream-cite) or an act citation (act-cite) confirming the
  // memory was useful. These tests are the bump path that lets the term earn its
  // weight — without them verdict_boost stays 0 in prod and the coefficient is dead.
  it("raises verdict_boost on a citation (reason='act-cite')", async () => {
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    await reinforce({ db, id: e.id, factor: 1.5, reason: "act-cite" });
    const row = await db.get<any>("SELECT verdict_boost FROM memory WHERE id = ?", [e.id]);
    expect(Number(row.verdict_boost)).toBe(1);
    await db.close();
  });

  it("raises verdict_boost on a citation (reason='dream-cite')", async () => {
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    await reinforce({ db, id: e.id, factor: 1.2, reason: "dream-cite" });
    await reinforce({ db, id: e.id, factor: 1.2, reason: "dream-cite" });
    const row = await db.get<any>("SELECT verdict_boost FROM memory WHERE id = ?", [e.id]);
    expect(Number(row.verdict_boost)).toBe(2);
    await db.close();
  });

  it("does NOT raise verdict_boost on a non-citation reason (e.g. decay)", async () => {
    // Decay is a penalty pass, not a confirmation. Only the two citation reasons
    // that also bump the citation counters may feed the verdict_boost signal —
    // otherwise routine decay would silently inflate ranking.
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    await reinforce({ db, id: e.id, factor: 0.9, reason: "decay" });
    const row = await db.get<any>("SELECT verdict_boost FROM memory WHERE id = ?", [e.id]);
    expect(Number(row.verdict_boost)).toBe(0);
    await db.close();
  });

  it("verdict_boost rises unbounded in storage; the cap is applied at scoring time", async () => {
    // The store is uncapped (matches bumpVerdictBoost: current + 1). The ranking
    // cap lives once in recall.ts (VERDICT_BOOST_CAP=5, applied as min(boost,5)/5),
    // so six citations score identically to five — proving the cap holds for the
    // ranking signal without a duplicated stored ceiling.
    const { combineScoresWithBreakdown } = await import(
      "../../../src/tools/memory/recall.js"
    );
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    for (let i = 0; i < 6; i++) {
      await reinforce({ db, id: e.id, factor: 1.0, reason: "act-cite" });
    }
    const row = await db.get<any>("SELECT verdict_boost FROM memory WHERE id = ?", [e.id]);
    expect(Number(row.verdict_boost)).toBe(6); // stored value is uncapped

    const scoreRow = {
      id: e.id, content: "x", weight: 1, sources: "[]",
      type: "observation", tier: "stm",
      last_reinforced: "2026-05-13T00:00:00Z", verdict_boost: 6,
    };
    const cappedRow = { ...scoreRow, verdict_boost: 5 };
    const weights = { bm25: 0.4, cos: 0.4, weight: 0.1, recency: 0.05, verdict: 0.05 };
    const nowMs = new Date("2026-05-13T00:00:00Z").getTime();
    const at6 = combineScoresWithBreakdown({
      ftsRows: [{ id: e.id, bm25_score: -1 }], vecRows: [],
      memoryRows: new Map([[e.id, scoreRow]]),
      weights, nowMs, recencyDecayMs: 1000 * 60 * 60 * 24 * 30, k: 1,
    });
    const at5 = combineScoresWithBreakdown({
      ftsRows: [{ id: e.id, bm25_score: -1 }], vecRows: [],
      memoryRows: new Map([[e.id, cappedRow]]),
      weights, nowMs, recencyDecayMs: 1000 * 60 * 60 * 24 * 30, k: 1,
    });
    expect(at6[0].breakdown.verdict).toBeCloseTo(at5[0].breakdown.verdict, 6);
    expect(at6[0].breakdown.verdict).toBeCloseTo(0.05, 6); // 0.05 * min(6,5)/5
    await db.close();
  });

  it("a citation is a normal UPDATE memory that advances change_seq (cache-safety)", async () => {
    // verdict_boost must be written through the same UPDATE that already fires
    // bump_seq_on_memory_update, so recall_cache invalidates. A write that bumped
    // verdict_boost without advancing change_seq would serve stale rankings.
    const { db, embedder } = await setup();
    const e = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    const before = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id=1");
    await reinforce({ db, id: e.id, factor: 1.5, reason: "act-cite" });
    const after = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id=1");
    // Exactly one seq bump — a single UPDATE, not verdict_boost via a second write.
    expect(Number(after?.s)).toBe(Number(before?.s) + 1);
    await db.close();
  });
});

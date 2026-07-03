import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { writeLtm } from "../../../src/tools/memory/write-ltm.js";
import { recall, combineScores, type MemoryRowForScore } from "../../../src/tools/memory/recall.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

async function setupDeterministic(embeddings: Record<string, Float32Array>) {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
  const client = new OllamaClient();
  vi.spyOn(client, "embed").mockImplementation(async ({ input }) => {
    if (embeddings[input]) return embeddings[input];
    return new Float32Array([0, 0, 0, 0]);
  });
  return { db, embedder: new Embedder({ client, model: "test" }) };
}

describe("recall", () => {
  it("returns FTS-matching entries", async () => {
    const { db, embedder } = await setupDeterministic({
      "freshness issue x": new Float32Array([1, 0, 0, 0]),
      "unrelated topic":   new Float32Array([0, 1, 0, 0]),
      "freshness query":   new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "freshness issue x", sources: [] } });
    await writeStm({ db, embedder, input: { type: "observation", content: "unrelated topic", sources: [] } });
    const r = await recall({ db, embedder, input: { cue: "freshness query", k: 5 } });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].content).toContain("freshness");
  });

  it("filters by tier", async () => {
    const { db, embedder } = await setupDeterministic({
      "alpha": new Float32Array([1, 0, 0, 0]),
      "beta":  new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "alpha", sources: [] } });
    await writeLtm({ db, embedder, input: { type: "lesson", content: "beta", sources: [], reason: "r" } });
    const r = await recall({ db, embedder, input: { cue: "alpha or beta", k: 10, tier: "ltm" } });
    for (const e of r) {
      expect(e.id).toMatch(/^ltm_/);
    }
  });

  it("uses cache on second identical call with no new STM", async () => {
    const { db, embedder } = await setupDeterministic({
      "x": new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "x", sources: [] } });
    const spy = vi.spyOn(embedder, "embed");
    const before = spy.mock.calls.length;
    await recall({ db, embedder, input: { cue: "x", k: 5 } });
    const afterFirst = spy.mock.calls.length;
    await recall({ db, embedder, input: { cue: "x", k: 5 } });
    const afterSecond = spy.mock.calls.length;
    expect(afterFirst - before).toBe(1);
    expect(afterSecond - afterFirst).toBe(0);
  });

  it("filters by types", async () => {
    const { db, embedder } = await setupDeterministic({
      "obs content": new Float32Array([1, 0, 0, 0]),
      "lesson content": new Float32Array([1, 0, 0, 0]),
      "query": new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "obs content", sources: [] } });
    await writeLtm({ db, embedder, input: { type: "lesson", content: "lesson content", sources: [], reason: "r" } });
    const r = await recall({ db, embedder, input: { cue: "query", k: 10, types: ["lesson"] } });
    for (const e of r) {
      expect(e.type).toBe("lesson");
    }
    expect(r.length).toBeGreaterThan(0);
  });

  it("invalidates cache when a memory mutation bumps the seq", async () => {
    const { db, embedder } = await setupDeterministic({
      "alpha": new Float32Array([1, 0, 0, 0]),
      "beta": new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "alpha", sources: [] } });
    const spy = vi.spyOn(embedder, "embed");
    const before = spy.mock.calls.length;

    await recall({ db, embedder, input: { cue: "alpha", k: 5 } });
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst - before).toBe(1);

    // Any memory mutation bumps the seq — this writeStm forces cache invalidation
    // regardless of whether two STM ids happen to sort the same way.
    await writeStm({ db, embedder, input: { type: "observation", content: "beta", sources: [] } });
    const afterWrite = spy.mock.calls.length;

    await recall({ db, embedder, input: { cue: "alpha", k: 5 } });
    const afterSecond = spy.mock.calls.length;
    expect(afterSecond - afterWrite).toBe(1);
  });

  it("invalidates cache when reinforce mutates memory (covers non-INSERT path)", async () => {
    const { db, embedder } = await setupDeterministic({ "alpha": new Float32Array([1, 0, 0, 0]) });
    const stm = await writeStm({ db, embedder, input: { type: "observation", content: "alpha", sources: [] } });
    const spy = vi.spyOn(embedder, "embed");
    await recall({ db, embedder, input: { cue: "alpha", k: 5 } }); // populate cache
    const afterRecall = spy.mock.calls.length;

    const { reinforce } = await import("../../../src/tools/memory/reinforce.js");
    await reinforce({ db, id: stm.id, factor: 0.9, reason: "decay" });

    await recall({ db, embedder, input: { cue: "alpha", k: 5 } });
    expect(spy.mock.calls.length - afterRecall).toBe(1); // cache invalidated, embed re-called
  });

  it("cache hit respects a smaller k than originally cached", async () => {
    const { db, embedder } = await setupDeterministic({
      "a": new Float32Array([1, 0, 0, 0]),
      "b": new Float32Array([1, 0, 0, 0]),
      "c": new Float32Array([1, 0, 0, 0]),
      "query": new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "a", sources: [] } });
    await writeStm({ db, embedder, input: { type: "observation", content: "b", sources: [] } });
    await writeStm({ db, embedder, input: { type: "observation", content: "c", sources: [] } });

    const big = await recall({ db, embedder, input: { cue: "query", k: 10 } });
    // The first call populates the cache with up to 10 hits.

    const small = await recall({ db, embedder, input: { cue: "query", k: 2 } });
    expect(small.length).toBeLessThanOrEqual(2);
    expect(small.length).toBeLessThanOrEqual(big.length);
  });

  it("logs to memory_ops_log on cache miss only", async () => {
    const { db, embedder } = await setupDeterministic({
      "thing": new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "thing", sources: [] } });

    await recall({ db, cycleId: "c_recall_test", embedder, input: { cue: "thing", k: 5 } });
    const afterFirst = await db
      .all("SELECT * FROM memory_ops_log WHERE op = 'recall'") as any[];
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].cycle_id).toBe("c_recall_test");
    const summary = JSON.parse(afterFirst[0].result_summary);
    expect(summary).toHaveProperty("hits");
    expect(typeof summary.hits).toBe("number");

    // Second call — cache hit, no ops_log row should be added.
    await recall({ db, embedder, input: { cue: "thing", k: 5 } });
    const afterSecond = await db
      .all("SELECT * FROM memory_ops_log WHERE op = 'recall'") as any[];
    expect(afterSecond.length).toBe(1);
  });

  it("writes a recall_trace row with results and near-misses on cache miss", async () => {
    const { db, embedder } = await setupDeterministic({
      "alpha": new Float32Array([1, 0, 0, 0]),
      "beta": new Float32Array([1, 0, 0, 0]),
      "query": new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "alpha", sources: [] } });
    await writeStm({ db, embedder, input: { type: "observation", content: "beta", sources: [] } });

    await recall({ db, embedder, cycleId: "c_trace", caller: "judge", input: { cue: "query", k: 1 } });

    const traces = await db.all<any>("SELECT * FROM recall_trace WHERE cycle_id = 'c_trace'");
    expect(traces).toHaveLength(1);
    expect(traces[0].caller).toBe("judge");
    expect(traces[0].k).toBe(1);
    expect(traces[0].miss).toBe(0);
    const results = JSON.parse(traces[0].results);
    expect(results.length).toBe(1);
    expect(results[0]).toHaveProperty("breakdown");
    expect(results[0].injected).toBe(true);
    const misses = JSON.parse(traces[0].misses);
    expect(misses.length).toBeGreaterThanOrEqual(1); // beta is a near-miss at k=1
    expect(misses[0].injected).toBe(false);
  });

  it("recall_trace results equal the returned hits, in order", async () => {
    // Three memories, all FTS-matching the cue, with distinct vector cosines so
    // the fusion produces a strict, non-trivial ordering and one near-miss at k=2.
    const { db, embedder } = await setupDeterministic({
      "alpha": new Float32Array([1, 0, 0, 0]),
      "beta": new Float32Array([0.6, 0.8, 0, 0]),
      "gamma": new Float32Array([0, 1, 0, 0]),
      "alpha beta gamma": new Float32Array([1, 0, 0, 0]),
    });
    await writeStm({ db, embedder, input: { type: "observation", content: "alpha", sources: [] } });
    await writeStm({ db, embedder, input: { type: "observation", content: "beta", sources: [] } });
    await writeStm({ db, embedder, input: { type: "observation", content: "gamma", sources: [] } });

    // Capture what recall() actually returned …
    const r = await recall({ db, embedder, cycleId: "c_match", caller: "judge", input: { cue: "alpha beta gamma", k: 2 } });
    // … and what it persisted into the trace's injected results.
    const trace = await db.get<any>("SELECT results FROM recall_trace WHERE cycle_id = 'c_match'");
    const tracedIds = JSON.parse(trace.results).map((x: any) => x.id);

    // The invariant under test: the trace's top-k IDs are exactly the returned
    // hit IDs, in the same order — not a copy-paste coincidence of two fusions.
    expect(tracedIds).toEqual(r.map((h: any) => h.id));
    expect(r.length).toBe(2);
  });

  it("trace write failure does not fail the recall", async () => {
    const { db, embedder } = await setupDeterministic({ "x": new Float32Array([1, 0, 0, 0]) });
    await writeStm({ db, embedder, input: { type: "observation", content: "x", sources: [] } });
    // Force the recall_trace table away so the trace insert throws.
    await db.run("DROP TABLE recall_trace");
    const r = await recall({ db, embedder, cycleId: "c_drop", input: { cue: "x", k: 5 } });
    expect(r.length).toBeGreaterThan(0); // recall still returns

    // The atomic batch (ops-log + trace) rolls back when the trace insert throws,
    // so the catch-block fallback `db.run(opsLog.sql, ...)` MUST re-record the
    // ops-log row on its own — otherwise recall-compliance metrics are silently
    // lost on every best-effort trace failure. Assert the row survived.
    const opsRows = await db.all(
      "SELECT * FROM memory_ops_log WHERE op = 'recall' AND cycle_id = 'c_drop'"
    ) as any[];
    expect(opsRows.length).toBe(1);
  });

  it("the live fusion scores a citation-boosted row above an identical plain row", async () => {
    // End-to-end proof that the flipped coefficient is load-bearing in PRODUCTION
    // recall(), not just in unit tests that pass weights explicitly. Both rows are
    // pinned to the SAME last_reinforced (fixed clock) so bm25+cos+weight+recency
    // are identical; reinforce raises ONE row's verdict_boost via the real act-cite
    // bump path, making verdict_boost the only differing axis. ONLY a non-zero live
    // W_VERDICT can separate them — under the old gate (W_VERDICT=0) the scores tie
    // and `toBeGreaterThan` fails.
    const { reinforce } = await import("../../../src/tools/memory/reinforce.js");
    const { db, embedder } = await setupDeterministic({
      "shared cue": new Float32Array([1, 0, 0, 0]),
    });
    const fixed = () => new Date("2026-05-13T00:00:00Z");
    const boosted = await writeStm({ db, embedder, now: fixed, input: { type: "observation", content: "shared cue", sources: [] } });
    const plain = await writeStm({ db, embedder, now: fixed, input: { type: "observation", content: "shared cue", sources: [] } });
    // factor 1.0 keeps weight identical and the fixed clock keeps last_reinforced
    // identical, so verdict_boost is the ONLY axis that differs between the rows.
    await reinforce({ db, id: boosted.id, factor: 1.0, reason: "act-cite", now: fixed });

    const r = await recall({ db, embedder, now: fixed, input: { cue: "shared cue", k: 10 } });
    const boostedScore = r.find((h) => h.id === boosted.id)?.score;
    const plainScore = r.find((h) => h.id === plain.id)?.score;
    expect(boostedScore).toBeDefined();
    expect(plainScore).toBeDefined();
    // Separation is exactly the verdict term: 0.05 * min(1,5)/5 = 0.01.
    expect(boostedScore!).toBeGreaterThan(plainScore!);
    expect(boostedScore! - plainScore!).toBeCloseTo(0.05 * (1 / 5), 6);
    await db.close();
  });
});

describe("combineScores", () => {
  // SHIPPED weights — mirror the live constants in recall.ts. The verdict term is
  // ACTIVE (W_VERDICT=0.05, recency ceded half its coefficient to 0.05) now that
  // reinforce bumps verdict_boost on every act-cite/dream-cite citation. These are
  // the fusion recall() actually ships: 0.4·bm25 + 0.4·cos + 0.1·weight
  // + 0.05·recency + 0.05·min(verdict_boost,5)/5.
  const weights = { bm25: 0.4, cos: 0.4, weight: 0.1, recency: 0.05, verdict: 0.05 };
  const nowMs = new Date("2026-05-13T00:00:00Z").getTime();
  const recencyDecayMs = 1000 * 60 * 60 * 24 * 30;

  function row(id: string, overrides: Partial<MemoryRowForScore> = {}): MemoryRowForScore {
    return {
      id,
      content: id,
      weight: 1,
      sources: "[]",
      type: "observation",
      tier: "stm",
      last_reinforced: "2026-05-13T00:00:00Z",
      verdict_boost: 0,
      ...overrides,
    };
  }

  it("returns empty when neither fts nor vec produced hits", () => {
    const r = combineScores({
      ftsRows: [],
      vecRows: [],
      memoryRows: new Map(),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r).toEqual([]);
  });

  it("uses vec-only path when fts is empty", () => {
    const r = combineScores({
      ftsRows: [],
      vecRows: [{ id: "a", distance: 0.2 }],
      memoryRows: new Map([["a", row("a")]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("a");
    // SHIPPED fusion (verdict active at 0.05, recency ceded to 0.05):
    // cos = 1 - 0.2 = 0.8; bm25 = 0; weight = 1; recency = 1; verdict_boost = 0
    // total = 0.4*0 + 0.4*0.8 + 0.1*1 + 0.05*1 + 0.05*(min(0,5)/5) = 0.32 + 0.1 + 0.05 = 0.47
    expect(r[0].score).toBeCloseTo(0.47, 4);
  });

  it("ranks higher weight above lower weight when other scores match", () => {
    const r = combineScores({
      ftsRows: [{ id: "high", bm25_score: -1 }, { id: "low", bm25_score: -1 }],
      vecRows: [{ id: "high", distance: 0.5 }, { id: "low", distance: 0.5 }],
      memoryRows: new Map([
        ["high", row("high", { weight: 1 })],
        ["low",  row("low",  { weight: 0.1 })],
      ]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r[0].id).toBe("high");
    expect(r[1].id).toBe("low");
  });

  it("ranks recent above old when other scores match", () => {
    const r = combineScores({
      ftsRows: [{ id: "new", bm25_score: -1 }, { id: "old", bm25_score: -1 }],
      vecRows: [{ id: "new", distance: 0.5 }, { id: "old", distance: 0.5 }],
      memoryRows: new Map([
        ["new", row("new", { last_reinforced: "2026-05-13T00:00:00Z" })],
        ["old", row("old", { last_reinforced: "2025-05-13T00:00:00Z" })],
      ]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r[0].id).toBe("new");
    expect(r[1].id).toBe("old");
  });

  it("respects k limit", () => {
    const ftsRows = [...Array(20)].map((_, i) => ({ id: `e${i}`, bm25_score: -1 - i / 100 }));
    const memoryRows = new Map(ftsRows.map((r) => [r.id, row(r.id)]));
    const r = combineScores({
      ftsRows,
      vecRows: [],
      memoryRows,
      weights, nowMs, recencyDecayMs, k: 5,
    });
    expect(r).toHaveLength(5);
  });

  it("skips ids missing from memoryRows", () => {
    const r = combineScores({
      ftsRows: [{ id: "present", bm25_score: -1 }, { id: "missing", bm25_score: -1 }],
      vecRows: [],
      memoryRows: new Map([["present", row("present")]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("present");
  });

  it("parses sources JSON in the returned hit", () => {
    const r = combineScores({
      ftsRows: [{ id: "a", bm25_score: -1 }],
      vecRows: [],
      memoryRows: new Map([["a", row("a", { sources: JSON.stringify(["log:x", "git:abc"]) })]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r[0].sources).toEqual(["log:x", "git:abc"]);
  });

  it("adds the capped+scaled verdict_boost term (active in the shipped fusion)", () => {
    // SHIPPED weights: the verdict term now contributes to the score recall() ships.
    const r = combineScores({
      ftsRows: [{ id: "a", bm25_score: -1 }],
      vecRows: [],
      memoryRows: new Map([["a", row("a", { verdict_boost: 5, weight: 0, last_reinforced: "2000-01-01T00:00:00Z" })]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    // bm25Norm = 1 (only row, normalised against itself); cos = 0; weight = 0;
    // recency ≈ 0 (ancient); verdict term = 0.05 * min(5,5)/5 = 0.05
    // total ≈ 0.4*1 + 0.05 = 0.45
    expect(r[0].score).toBeCloseTo(0.45, 2);
  });

  it("caps verdict_boost at 5 (boost of 10 scores the same as 5)", () => {
    const at5 = combineScores({
      ftsRows: [{ id: "a", bm25_score: -1 }],
      vecRows: [],
      memoryRows: new Map([["a", row("a", { verdict_boost: 5, weight: 0, last_reinforced: "2000-01-01T00:00:00Z" })]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    const at10 = combineScores({
      ftsRows: [{ id: "a", bm25_score: -1 }],
      vecRows: [],
      memoryRows: new Map([["a", row("a", { verdict_boost: 10, weight: 0, last_reinforced: "2000-01-01T00:00:00Z" })]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(at10[0].score).toBeCloseTo(at5[0].score, 6);
  });

  it("ranks higher verdict_boost above lower when other scores match", () => {
    // With the verdict term active (W_VERDICT=0.05), a memory the citation path
    // confirmed useful (verdict_boost>0) outranks an otherwise-identical plain row.
    const r = combineScores({
      ftsRows: [{ id: "boosted", bm25_score: -1 }, { id: "plain", bm25_score: -1 }],
      vecRows: [{ id: "boosted", distance: 0.5 }, { id: "plain", distance: 0.5 }],
      memoryRows: new Map([
        ["boosted", row("boosted", { verdict_boost: 5 })],
        ["plain",   row("plain",   { verdict_boost: 0 })],
      ]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r[0].id).toBe("boosted");
    expect(r[1].id).toBe("plain");
  });

  it("combineScoresWithBreakdown returns per-component scores per hit", async () => {
    const { combineScoresWithBreakdown } = await import("../../../src/tools/memory/recall.js");
    const r = combineScoresWithBreakdown({
      ftsRows: [],
      vecRows: [{ id: "a", distance: 0.2 }],
      memoryRows: new Map([["a", {
        id: "a", content: "a", weight: 1, sources: "[]",
        type: "lesson", tier: "ltm", last_reinforced: "2026-05-13T00:00:00Z",
        verdict_boost: 0,
      }]]),
      // SHIPPED weights (verdict active at 0.05, recency ceded to 0.05) — this is
      // what recall_trace records, so it must mirror recall.ts's live constants.
      weights: { bm25: 0.4, cos: 0.4, weight: 0.1, recency: 0.05, verdict: 0.05 },
      nowMs: new Date("2026-05-13T00:00:00Z").getTime(),
      recencyDecayMs: 1000 * 60 * 60 * 24 * 30,
      k: 10,
    });
    expect(r).toHaveLength(1);
    // breakdown stores the WEIGHTED contribution (what moved the rank):
    // cos = 1 - 0.2 = 0.8, bm25 = 0, weight = 1, recency = 1, verdict_boost = 0
    expect(r[0].breakdown.cos).toBeCloseTo(0.32, 4);      // 0.4 * 0.8
    expect(r[0].breakdown.bm25).toBeCloseTo(0, 4);        // 0.4 * 0
    expect(r[0].breakdown.weight).toBeCloseTo(0.1, 4);    // 0.1 * 1
    expect(r[0].breakdown.recency).toBeCloseTo(0.05, 4);  // 0.05 * 1
    expect(r[0].breakdown.verdict).toBeCloseTo(0, 4);     // 0.05 * (min(0,5)/5)
    expect(r[0].score).toBeCloseTo(0.47, 4);
  });
});

describe("combineScoresWithBreakdown — verdict term", () => {
  // SHIPPED weights — mirror recall.ts. verdict active at 0.05; recency ceded to 0.05.
  const weights = { bm25: 0.4, cos: 0.4, weight: 0.1, recency: 0.05, verdict: 0.05 };
  const nowMs = new Date("2026-05-13T00:00:00Z").getTime();
  const recencyDecayMs = 1000 * 60 * 60 * 24 * 30;

  function row(id: string, overrides: Partial<MemoryRowForScore> = {}): MemoryRowForScore {
    return {
      id,
      content: id,
      weight: 1,
      sources: "[]",
      type: "lesson",
      tier: "ltm",
      last_reinforced: "2026-05-13T00:00:00Z",
      verdict_boost: 0,
      ...overrides,
    };
  }

  it("has an active verdict component and the breakdown sums to score", async () => {
    const { combineScoresWithBreakdown } = await import(
      "../../../src/tools/memory/recall.js"
    );
    const r = combineScoresWithBreakdown({
      ftsRows: [],
      vecRows: [{ id: "a", distance: 0.2 }],
      memoryRows: new Map([["a", row("a", { verdict_boost: 5 })]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(r).toHaveLength(1);
    // SHIPPED fusion: cos = 1 - 0.2 = 0.8; bm25 = 0; weight = 1; recency = 1;
    // verdict term value = min(5,5)/5 = 1, weighted at the active W_VERDICT=0.05.
    expect(r[0].breakdown.bm25).toBeCloseTo(0, 4);      // 0.4 * 0
    expect(r[0].breakdown.cos).toBeCloseTo(0.32, 4);    // 0.4 * 0.8
    expect(r[0].breakdown.weight).toBeCloseTo(0.1, 4);  // 0.1 * 1
    expect(r[0].breakdown.recency).toBeCloseTo(0.05, 4); // 0.05 * 1
    // The verdict field equals W_VERDICT*min(boost,5)/5 = 0.05*1 now that the
    // coefficient is active via the reinforce citation bump path.
    expect(r[0].breakdown.verdict).toBeCloseTo(0.05, 4); // 0.05 * 1
    const b = r[0].breakdown;
    const sum = b.bm25 + b.cos + b.weight + b.recency + b.verdict;
    expect(sum).toBeCloseTo(r[0].score, 6); // breakdown sums to the fused score
    expect(r[0].score).toBeCloseTo(0.52, 4); // 0.32 + 0.1 + 0.05 + 0.05
  });

  it("caps the verdict component at 5 (boost of 10 == boost of 5)", async () => {
    const { combineScoresWithBreakdown } = await import(
      "../../../src/tools/memory/recall.js"
    );
    const at5 = combineScoresWithBreakdown({
      ftsRows: [], vecRows: [{ id: "a", distance: 0.2 }],
      memoryRows: new Map([["a", row("a", { verdict_boost: 5 })]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    const at10 = combineScoresWithBreakdown({
      ftsRows: [], vecRows: [{ id: "a", distance: 0.2 }],
      memoryRows: new Map([["a", row("a", { verdict_boost: 10 })]]),
      weights, nowMs, recencyDecayMs, k: 10,
    });
    expect(at10[0].breakdown.verdict).toBeCloseTo(at5[0].breakdown.verdict, 6);
    expect(at5[0].breakdown.verdict).toBeCloseTo(0.05, 4); // 0.05 * min(5,5)/5
  });
});

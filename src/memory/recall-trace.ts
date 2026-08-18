import type { MemoryDb } from "./libsql-db.js";

/** Per-component score breakdown for one ranked candidate. Mirrors the fusion
 *  terms in combineScores (bm25 + cos + weight + recency + verdict). */
export interface ScoreBreakdown {
  bm25: number;
  cos: number;
  weight: number;
  recency: number;
  verdict: number;
}

/** A fully-ranked candidate as produced by the traced recall path. */
export interface ScoredHit {
  id: string;
  content: string;
  weight: number;
  type: string;
  tier: string;
  sources: string[];
  score: number;
  /** ISO timestamps, carried so callers can render an age. */
  created: string;
  last_reinforced: string;
  breakdown: ScoreBreakdown;
}

/** One row inside the trace `results`/`misses` JSON arrays. */
export interface TraceResult {
  id: string;
  rank: number;
  score: number;
  breakdown: ScoreBreakdown;
  injected: boolean;
}

export interface TraceResultSets {
  results: TraceResult[];
  misses: TraceResult[];
}

/** Slice a fully-ranked list into the top-k (injected=true) and the
 *  near-miss window ranks k+1..k+10 (injected=false). */
export function buildTraceResults(ranked: ScoredHit[], k: number): TraceResultSets {
  const toResult = (h: ScoredHit, rank: number, injected: boolean): TraceResult => ({
    id: h.id, rank, score: h.score, breakdown: h.breakdown, injected,
  });
  const results = ranked.slice(0, k).map((h, i) => toResult(h, i + 1, true));
  const misses = ranked.slice(k, k + 10).map((h, i) => toResult(h, k + i + 1, false));
  return { results, misses };
}

export interface WriteTraceInput {
  repo: string;
  cycleId: string;
  caller: string;
  cue: string;
  k: number;
  filters: Record<string, unknown>;
  sets: TraceResultSets;
  timestamp: string;
}

/** Best-effort: returns the statements to batch with the memory_ops_log insert.
 *  Caller is responsible for batching so the two land in one write. */
export function traceInsertStatement(input: WriteTraceInput): { sql: string; args: (string | number)[] } {
  return {
    sql: `INSERT INTO recall_trace (repo, cycle_id, caller, cue, k, filters, results, misses, miss, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    args: [
      input.repo, input.cycleId, input.caller, input.cue, input.k,
      JSON.stringify(input.filters),
      JSON.stringify(input.sets.results),
      JSON.stringify(input.sets.misses),
      input.timestamp,
    ],
  };
}

/** Retention sweep mirroring the decay-sweep pattern: drop trace rows older
 *  than 30 days. Best-effort; returns the number deleted. */
export async function sweepRecallTraces(deps: { db: MemoryDb; now?: () => Date }): Promise<{ deleted_n: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const before = await deps.db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM recall_trace WHERE timestamp < ?",
    [cutoff]
  );
  await deps.db.run("DELETE FROM recall_trace WHERE timestamp < ?", [cutoff]);
  return { deleted_n: Number(before?.c ?? 0) };
}

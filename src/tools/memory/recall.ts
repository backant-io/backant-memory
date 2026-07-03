import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { cacheKey, readCache, writeCache, currentMemorySeq } from "../../memory/cache.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import type { ScoredHit, ScoreBreakdown } from "../../memory/recall-trace.js";
import { buildTraceResults, traceInsertStatement } from "../../memory/recall-trace.js";

export interface RecallInput {
  cue: string;
  k?: number;
  tier?: "any" | "stm" | "ltm";
  types?: string[];
  with_edges?: boolean;
  /** When true, recall across all repos in the namespace (same owner). */
  cross_repo?: boolean;
}

export interface RecallDeps {
  db: MemoryDb;
  embedder: Embedder;
  /** Current repo key (owner/repo); defaults to db.repo. Recall is filtered to it unless cross_repo. */
  repo?: string;
  cycleId?: string;
  /** Logical caller of this recall (judge|act|retry|session-start|plan-epic|dream).
   *  Recorded in recall_trace; defaults to "unknown". */
  caller?: string;
  /** Skip the recall cache read so a fresh trace is always written; used by
   *  diagnostics like `backant memory why --query`, where a cache hit would
   *  short-circuit before recomputing the full ranking and writing a trace. */
  bypassCache?: boolean;
  input: RecallInput;
  now?: () => Date;
}

export interface RecallHit {
  id: string;
  content: string;
  weight: number;
  score: number;
  sources: string[];
  type: string;
  tier: string;
  edges?: unknown[];
}

export interface MemoryRowForScore {
  id: string;
  content: string;
  weight: number;
  sources: string;
  type: string;
  tier: string;
  last_reinforced: string;
  verdict_boost: number;
}

export interface ScoreWeights {
  bm25: number;
  cos: number;
  weight: number;
  recency: number;
  verdict: number;
}

export interface CombineScoresInput {
  ftsRows: { id: string; bm25_score: number }[];
  vecRows: { id: string; distance: number }[];
  memoryRows: Map<string, MemoryRowForScore>;
  weights: ScoreWeights;
  nowMs: number;
  recencyDecayMs: number;
  k: number;
}

const W_BM25    = 0.4;
const W_COS     = 0.4;
const W_WGT     = 0.1;
// verdict_boost term ACTIVE (spec §2.4): reinforce() raises verdict_boost on every
// act-cite/dream-cite citation (a normal `UPDATE memory`, so change_seq advances and
// recall_cache stays correct), giving the term a real, code-driven bump path. Recency
// ceded half its coefficient to fund it. Full fusion:
//   0.4·bm25 + 0.4·cos + 0.1·weight + 0.05·recency + 0.05·min(verdict_boost,5)/5.
const W_REC     = 0.05;
const W_VERDICT = 0.05;
const VERDICT_BOOST_CAP = 5;
const RECENCY_DECAY_MS_30D = 1000 * 60 * 60 * 24 * 30;
const HYBRID_TOP_N = 50;

/** Top-k fusion projection over {@link combineScoresWithBreakdown}: same ranking,
 *  with the per-component breakdown dropped. combineScoresWithBreakdown is the
 *  single source of truth for the fusion math — combineScores has no live caller
 *  in src/ since recall() compute-once derives its hits from the breakdown list,
 *  and is retained as the tested public contract for the breakdown-free shape. */
export function combineScores(input: CombineScoresInput): RecallHit[] {
  return combineScoresWithBreakdown(input)
    .slice(0, input.k)
    .map(stripBreakdown);
}

function stripBreakdown(hit: ScoredHit): RecallHit {
  const { breakdown: _breakdown, ...rest } = hit;
  return rest;
}

/** The single source of truth for the recall fusion: returns every candidate
 *  (sorted desc) with its per-component breakdown preserved. Used directly by the
 *  traced recall path; combineScores is a top-k, breakdown-free projection of it. */
export function combineScoresWithBreakdown(input: CombineScoresInput): ScoredHit[] {
  const combined = new Map<string, { bm25: number; cos: number }>();
  for (const r of input.ftsRows) combined.set(r.id, { bm25: -r.bm25_score, cos: 0 });
  for (const r of input.vecRows) {
    const existing = combined.get(r.id) ?? { bm25: 0, cos: 0 };
    combined.set(r.id, { ...existing, cos: 1 - r.distance });
  }
  if (combined.size === 0) return [];

  const maxBm25 = Math.max(
    0.0001,
    ...Array.from(combined.values()).map((c) => c.bm25)
  );

  const hits: ScoredHit[] = [];
  for (const [id, scores] of combined) {
    const row = input.memoryRows.get(id);
    if (!row) continue;
    const bm25Norm = scores.bm25 / maxBm25;
    const recency = Math.exp(
      -(input.nowMs - new Date(row.last_reinforced).getTime()) / input.recencyDecayMs
    );
    const verdictTerm =
      Math.min(row.verdict_boost, VERDICT_BOOST_CAP) / VERDICT_BOOST_CAP;
    const breakdown: ScoreBreakdown = {
      bm25: input.weights.bm25 * bm25Norm,
      cos: input.weights.cos * scores.cos,
      weight: input.weights.weight * row.weight,
      recency: input.weights.recency * recency,
      verdict: input.weights.verdict * verdictTerm,
    };
    const total =
      breakdown.bm25 + breakdown.cos + breakdown.weight + breakdown.recency + breakdown.verdict;
    hits.push({
      id: row.id,
      content: row.content,
      weight: row.weight,
      type: row.type,
      tier: row.tier,
      sources: JSON.parse(row.sources),
      score: total,
      breakdown,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

export async function recall(deps: RecallDeps): Promise<RecallHit[]> {
  const k = deps.input.k ?? 10;
  const tier = deps.input.tier ?? "any";
  const types = deps.input.types ?? [];
  const repo = deps.repo ?? deps.db.repo;

  const key = cacheKey({
    cue: deps.input.cue,
    tier,
    types,
    repo: deps.input.cross_repo ? "*" : repo,
  });
  const currentSeq = await currentMemorySeq(deps.db);
  // Diagnostics (bypassCache) skip the cache READ so the full ranking is
  // recomputed and a fresh recall_trace row is always written. writeCache below
  // still runs, keeping subsequent normal calls warm.
  if (!deps.bypassCache) {
    const cached = await readCache(deps.db, key);
    if (cached && cached.memory_seq_at_recall === currentSeq) {
      return (cached.result as RecallHit[]).slice(0, k);
    }
  }

  const queryVec = await deps.embedder.embed(deps.input.cue);
  const queryJson = embeddingToJson(queryVec);

  const repoClause = deps.input.cross_repo ? "" : "AND m.repo = @repo";
  const tierClause = tier === "any" ? "" : "AND m.tier = @tier";
  const typesClause = types.length
    ? "AND m.type IN (" + types.map((_, i) => `@t${i}`).join(",") + ")"
    : "";
  const typesParams: Record<string, string> = {};
  types.forEach((t, i) => (typesParams[`t${i}`] = t));
  // Bi-temporal validity (spec §4.2): default recall excludes invalidated rows.
  // valid_to IS NULL means currently valid. Applied to BOTH retrieval paths so a
  // superseded belief cannot surface via the vector path even if its FTS row was
  // deleted on supersede.
  const validityClause = "AND m.valid_to IS NULL";
  const base = { repo, tier, ...typesParams };

  const ftsRows = await deps.db.all<{ id: string; bm25_score: number }>(
    `SELECT m.id, bm25(memory_fts) AS bm25_score
     FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
     WHERE memory_fts MATCH @cue ${repoClause} ${tierClause} ${typesClause} ${validityClause}
     ORDER BY bm25(memory_fts) ASC LIMIT ${HYBRID_TOP_N}`,
    { ...base, cue: ftsQuery(deps.input.cue) }
  );

  const vecRows = await deps.db.all<{ id: string; distance: number }>(
    `SELECT m.id, vector_distance_cos(m.embedding, vector32(@vec)) AS distance
     FROM memory m
     WHERE m.embedding IS NOT NULL ${repoClause} ${tierClause} ${typesClause} ${validityClause}
     ORDER BY distance ASC LIMIT ${HYBRID_TOP_N}`,
    { ...base, vec: queryJson }
  );

  // Batch the row fetch — single IN query instead of N SELECT … WHERE id = ?
  const allIds = new Set<string>();
  for (const r of ftsRows) allIds.add(r.id);
  for (const r of vecRows) allIds.add(r.id);
  const idsArr = Array.from(allIds);

  let memoryRows = new Map<string, MemoryRowForScore>();
  if (idsArr.length > 0) {
    const placeholders = idsArr.map((_, i) => `@id${i}`).join(",");
    const rowParams: Record<string, string> = {};
    idsArr.forEach((id, i) => (rowParams[`id${i}`] = id));
    const rows = await deps.db.all<MemoryRowForScore>(
      `SELECT id, content, weight, sources, type, tier, last_reinforced, verdict_boost
       FROM memory WHERE id IN (${placeholders})`,
      rowParams
    );
    memoryRows = new Map(rows.map((r) => [r.id, r]));
  }

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const recencyDecayMs = RECENCY_DECAY_MS_30D;
  const weights = { bm25: W_BM25, cos: W_COS, weight: W_WGT, recency: W_REC, verdict: W_VERDICT };

  // Compute the fusion ONCE. `ranked` is the full sorted candidate list (with
  // per-component breakdowns); `top` is the top-k projection actually returned.
  // Deriving `top` from `ranked` makes "trace == returned hits" structural
  // rather than a copy-paste coincidence between two fusion implementations.
  const ranked = combineScoresWithBreakdown({
    ftsRows, vecRows, memoryRows, weights, nowMs, recencyDecayMs, k,
  });
  const top: RecallHit[] = ranked.slice(0, k).map((h) => ({
    id: h.id,
    content: h.content,
    weight: h.weight,
    score: h.score,
    sources: h.sources,
    type: h.type,
    tier: h.tier,
  }));

  await writeCache(deps.db, key, top, currentSeq);

  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;
  const timestamp = new Date().toISOString();

  // Build the trace from the FULL ranked list so near-misses (k+1..k+10) exist.
  const sets = buildTraceResults(ranked, k);

  // One write batch: the existing ops-log row + the best-effort trace row.
  // recall_trace is outside `memory`, so this does NOT bump change_seq.
  const opsLog = {
    sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
          VALUES (?, 'recall', ?, ?, ?)`,
    args: [cycleId, JSON.stringify(deps.input), JSON.stringify({ hits: top.length }), timestamp],
  };
  const trace = traceInsertStatement({
    repo,
    cycleId,
    caller: deps.caller ?? "unknown",
    cue: deps.input.cue,
    k,
    filters: { tier, types, cross_repo: deps.input.cross_repo ?? false },
    sets,
    timestamp,
  });
  try {
    await deps.db.batch([opsLog, trace]);
  } catch (err) {
    // Trace is best-effort. If the batch fails, still record the ops-log row
    // alone so recall-compliance metrics are not lost, and warn.
    process.stderr.write(
      `[recall-trace] trace write failed, recall unaffected: ${(err as Error).message}\n`
    );
    try {
      await deps.db.run(opsLog.sql, opsLog.args);
    } catch { /* ops-log also unavailable — nothing more to do */ }
  }

  return top;
}

function ftsQuery(cue: string): string {
  return cue
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/["']/g, ""))
    .map((w) => `"${w}"`)
    .join(" OR ");
}

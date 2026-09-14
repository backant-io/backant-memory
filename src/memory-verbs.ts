import { resolvePaths } from "./paths.js";
import { buildMemoryContext } from "./memory/context.js";
import { openMemoryDb, type MemoryDb } from "./memory/libsql-db.js";
import { deriveIdentity, readOrigin } from "./memory/repo-identity.js";
import { Embedder } from "./ollama/embeddings.js";
import { OllamaClient } from "./ollama/client.js";
import { recall, type RecallHit } from "./tools/memory/recall.js";
import { reinforce } from "./tools/memory/reinforce.js";
import { writeStm } from "./tools/memory/write-stm.js";
import { writeLtm } from "./tools/memory/write-ltm.js";
import { writeEpisode } from "./tools/memory/write-episode.js";
import { UNTRACKED_CYCLE_ID } from "./memory/constants.js";
export { CLI_MEMORY_VERBS } from "./constants.js";
import {
  ACTION_TYPES,
  EPISODE_OUTCOMES,
  type ActionType,
  type EpisodeExpected,
  type EpisodeOutcome,
} from "./memory/episodic-types.js";
import type { MemoryType, MemoryTier } from "./memory/types.js";


export interface CliStore {
  db: MemoryDb;
  repo: string;
  embedder: Embedder;
}

/**
 * Three of the four verbs embed before they can touch the store, and the bare
 * failure from `fetch` is the words "fetch failed", from a shell that cannot
 * tell a stopped ollama from a missing model from a typo in the URL. Name both,
 * and change nothing else.
 */
function embedderThatSaysWhereItFailed(inner: Embedder, url: string, model: string): Embedder {
  const say = (err: unknown) =>
    new Error(`embedding model unreachable: ${model} at ${url} (${(err as Error).message}); is ollama running?`);
  return {
    async embed(text: string) {
      try { return await inner.embed(text); } catch (err) { throw say(err); }
    },
    async embedBatch(texts: string[]) {
      try { return await inner.embedBatch(texts); } catch (err) { throw say(err); }
    },
  } as unknown as Embedder;
}

/**
 * Open the same store `serve` opens for stdio: repo-scoped by the git origin of
 * the cwd, local replica only. BACKANT_MEMORY_DB pins a fixed file, matching the
 * escape hatch `serve` already honours, so a test can point both surfaces at one
 * store and see one verb's write through the other's recall.
 */
export async function openCliStore(cwd: string = process.cwd()): Promise<CliStore> {
  const paths = resolvePaths();
  const embedder = embedderThatSaysWhereItFailed(
    new Embedder({
      client: new OllamaClient({ baseUrl: paths.ollamaUrl }),
      model: paths.embeddingModel,
    }),
    paths.ollamaUrl,
    paths.embeddingModel
  );
  const override = process.env.BACKANT_MEMORY_DB;
  if (override) {
    const repo = deriveIdentity(readOrigin(cwd)).repoKey;
    const db = await openMemoryDb({ localPath: override, repo });
    return { db, repo, embedder };
  }
  const ctx = await buildMemoryContext({
    workspaceCwd: cwd,
    embeddingModel: paths.embeddingModel,
    forceLocal: true,
  });
  return { db: ctx.db, repo: ctx.repo, embedder };
}

/** A coarse age, because a months-old note must not read like yesterday's. */
export function humanAge(iso: string | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

/** One JSON object per line, carrying exactly the five fields the skill documents. */
export function recallLines(hits: RecallHit[], nowMs: number = Date.now()): string[] {
  return hits.map((h) =>
    JSON.stringify({
      id: h.id,
      tier: h.tier,
      type: h.type,
      age: humanAge(h.created ?? h.last_reinforced, nowMs),
      content: h.content,
    })
  );
}

function nonEmpty(value: string, flag: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`${flag} must not be empty`);
  return v;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag} must be one of ${allowed.join("|")} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

export async function runRecall(
  store: CliStore,
  opts: { cue: string; k?: number; tier?: string; crossRepo?: boolean }
): Promise<string[]> {
  const hits = await recall({
    db: store.db,
    embedder: store.embedder,
    repo: store.repo,
    caller: "cli",
    input: {
      cue: opts.cue,
      k: opts.k ?? 10,
      tier: oneOf(opts.tier ?? "any", ["any", "stm", "ltm"] as const, "--tier"),
      cross_repo: opts.crossRepo ?? false,
    },
  });
  return recallLines(hits);
}

export async function runReinforce(
  store: CliStore,
  opts: { id: string; reason?: string; factor?: number }
): Promise<{ id: string; new_weight: number }> {
  // Same defaults the MCP handler uses, so the two surfaces move a row the same
  // way. `reason` is a CATEGORY, not a note: only act-cite and dream-cite raise
  // verdict_boost, and weight is capped at 1.0, so reinforcing a fresh write
  // moves the citation counters rather than the number.
  return reinforce({
    db: store.db,
    id: opts.id,
    factor: opts.factor ?? 1.2,
    reason: opts.reason ?? "act-cite",
  });
}

export async function runWrite(
  store: CliStore,
  opts: { tier: string; type: string; content: string; source: string; reason?: string }
): Promise<{ id: string; weight: number }> {
  const tier = oneOf(opts.tier, ["stm", "ltm"] as const satisfies readonly MemoryTier[], "--tier");
  // `type` is deliberately NOT a closed set here: the MCP memory_write schema
  // leaves it a free string (its description ends in "..."), and live rows carry
  // types outside the MemoryType union, `gotcha` among them. A CLI stricter than
  // the tool it mirrors would refuse writes the same store already holds.
  const type = nonEmpty(opts.type, "--type") as MemoryType;
  const sources = [opts.source];
  if (tier === "ltm") {
    const reason = (opts.reason ?? "").trim();
    if (!reason) {
      throw new Error("ltm writes require a reason (why this is durable, verified knowledge)");
    }
    return writeLtm({
      db: store.db,
      embedder: store.embedder,
      repo: store.repo,
      input: { type, content: opts.content, sources, reason },
    });
  }
  const written = await writeStm({
    db: store.db,
    embedder: store.embedder,
    repo: store.repo,
    input: { type, content: opts.content, sources },
  });
  return { id: written.id, weight: written.weight };
}

export async function runEpisode(
  store: CliStore,
  opts: {
    situation: string;
    action: string;
    expected: string;
    outcome: string;
    evidence?: string;
    actionType?: string;
    epicId?: string;
    source?: string;
  }
): Promise<{ id: string; weight: number }> {
  const expected = oneOf(opts.expected, ["success", "failure"] as const, "--expected") as EpisodeExpected;
  const outcome = oneOf(opts.outcome, EPISODE_OUTCOMES, "--outcome") as EpisodeOutcome;
  const actionType = oneOf(opts.actionType ?? "other", ACTION_TYPES, "--action-type") as ActionType;
  const written = await writeEpisode({
    db: store.db,
    embedder: store.embedder,
    repo: store.repo,
    ...(opts.source ? { source: opts.source } : {}),
    input: {
      situation: opts.situation,
      action_type: actionType,
      action_taken: opts.action,
      expected,
      outcome,
      evidence: opts.evidence ?? "",
      epic_id: opts.epicId ?? "adhoc",
      cycle_id: UNTRACKED_CYCLE_ID,
    },
  });
  return { id: written.id, weight: written.weight };
}

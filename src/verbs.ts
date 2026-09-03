import { resolvePaths } from "./paths.js";
export { VERBS } from "./constants.js";
import { buildMemoryContext } from "./memory/context.js";
import { openMemoryDb, type MemoryDb } from "./memory/libsql-db.js";
import { OllamaClient } from "./ollama/client.js";
import { Embedder } from "./ollama/embeddings.js";
import { UNTRACKED_CYCLE_ID } from "./memory/constants.js";
import { ACTION_TYPES, EPISODE_OUTCOMES, type ActionType, type EpisodeExpected, type EpisodeOutcome } from "./memory/episodic-types.js";
import type { MemoryType, MemoryTier } from "./memory/types.js";
import { recall } from "./tools/memory/recall.js";
import { reinforce } from "./tools/memory/reinforce.js";
import { writeStm } from "./tools/memory/write-stm.js";
import { writeLtm } from "./tools/memory/write-ltm.js";
import { writeEpisode } from "./tools/memory/write-episode.js";

/**
 * The four memory verbs as commands, for agents whose only channel is a shell.
 *
 * The office endorses this path over MCP on purpose (spec 2026-09-01
 * §12): one process, one command, one line back, and nothing that outlives the
 * turn. That makes these verbs a SECOND caller of the same operations the MCP
 * server exposes — never a second implementation of them. Everything below
 * delegates into `src/tools/memory/*`, resolves the store exactly the way
 * `serve --stdio` does, and stops at argument shape and output shape.
 *
 * The store is repo-scoped off the git origin of the cwd, so a verb run from a
 * checkout and an MCP tool call from a session in that checkout land on the same
 * rows. `BACKANT_MEMORY_DB` pins a fixed store on both paths, spelled here the
 * way the CLI's own `serve` branch spells it.
 */


/** The default reinforce factor and reason, matching the MCP `memory_reinforce`
 *  handler: a CLI citation and a tool citation must move the weight the same. */
const REINFORCE_FACTOR = 1.2;
const REINFORCE_REASON = "act-cite";

export interface VerbSession {
  db: MemoryDb;
  embedder: Embedder;
  repo: string;
  close(): Promise<void>;
}

/**
 * Open the same store `serve` would open for this cwd.
 *
 * `forceLocal` mirrors the stdio branch: verbs read and write the local replica
 * and never provision a remote, so a verb is as cheap and as offline as the
 * session that runs it.
 */
export async function openSession(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<VerbSession> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolvePaths(env);
  const embedder = embedderThatSaysWhereItFailed(
    new Embedder({ client: new OllamaClient({ baseUrl: paths.ollamaUrl }), model: paths.embeddingModel }),
    paths.ollamaUrl,
    paths.embeddingModel
  );

  const dbOverride = env.BACKANT_MEMORY_DB;
  if (dbOverride) {
    // Pinned store: same spelling as `serve`'s override branch, including the
    // empty repo key, so a pinned CLI store and a pinned MCP store are one store
    // with one scope rather than two views of the same file.
    const db = await openMemoryDb({ localPath: dbOverride, repo: "" });
    return { db, embedder, repo: db.repo, close: () => db.close() };
  }

  const ctx = await buildMemoryContext({
    workspaceCwd: cwd,
    embeddingModel: paths.embeddingModel,
    forceLocal: true,
  });
  return { db: ctx.db, embedder, repo: ctx.repo, close: () => ctx.db.close() };
}

/**
 * The embedder, wrapped so a dead ollama says so.
 *
 * Three of the four verbs embed before they can touch the store, and the bare
 * failure from `fetch` is the word "fetch failed" — a caller reading that on a
 * shell has no way to tell a missing model from a stopped daemon from a typo in
 * the URL. The wrapper adds the two facts that distinguish them and changes
 * nothing else.
 */
function embedderThatSaysWhereItFailed(inner: Embedder, url: string, model: string): Embedder {
  const say = (err: unknown) =>
    new Error(`embedding model unreachable: ${model} at ${url} (${(err as Error).message}) — is ollama running?`);
  return {
    async embed(text: string) {
      try { return await inner.embed(text); } catch (err) { throw say(err); }
    },
    async embedBatch(texts: string[]) {
      try { return await inner.embedBatch(texts); } catch (err) { throw say(err); }
    },
  } as unknown as Embedder;
}

/** One recalled hit as the CLI prints it: enough to act on and to cite back. */
export interface RecallLine {
  id: string;
  tier: string;
  type: string;
  /** How long ago this was last reinforced, compact: `4h`, `3d`, `2mo`. */
  age: string;
  content: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Compact age for a timestamp.
 *
 * The hit carries an age rather than a raw ISO string because the thing a caller
 * decides with it is "is this stale?" — and a months-old note must not read like
 * yesterday's. Unparseable input answers `unknown` instead of `NaNd`.
 */
export function ageOf(iso: string | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const delta = Math.max(0, nowMs - then);
  if (delta < MINUTE) return `${Math.floor(delta / 1000)}s`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < MONTH) return `${Math.floor(delta / DAY)}d`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}

export async function runRecall(
  session: VerbSession,
  input: { cue: string; k?: number },
  now: () => number = Date.now
): Promise<RecallLine[]> {
  if (!input.cue.trim()) throw new Error("--cue must not be empty");
  const hits = await recall({
    db: session.db,
    embedder: session.embedder,
    repo: session.repo,
    caller: "cli",
    input: { cue: input.cue, ...(input.k !== undefined ? { k: input.k } : {}) },
  });
  const nowMs = now();
  return hits.map((h) => ({
    id: h.id,
    tier: h.tier,
    type: h.type,
    age: ageOf(h.last_reinforced ?? h.created, nowMs),
    content: h.content,
  }));
}

export async function runReinforce(
  session: VerbSession,
  input: { id: string; reason?: string }
): Promise<{ id: string; new_weight: number }> {
  if (!input.id.trim()) throw new Error("--id must not be empty");
  return reinforce({
    db: session.db,
    id: input.id,
    factor: REINFORCE_FACTOR,
    reason: input.reason?.trim() ? input.reason : REINFORCE_REASON,
  });
}

export interface WriteInput {
  tier: string;
  type: string;
  content: string;
  sources: string[];
  reason?: string;
}

export async function runWrite(
  session: VerbSession,
  input: WriteInput
): Promise<{ id: string; tier: MemoryTier; weight: number }> {
  const tier = input.tier as MemoryTier;
  if (tier !== "stm" && tier !== "ltm") {
    throw new Error(`--tier must be stm or ltm (got ${JSON.stringify(input.tier)})`);
  }
  if (!input.type.trim()) throw new Error("--type must not be empty");
  if (!input.content.trim()) throw new Error("--content must not be empty");
  if (input.sources.length === 0) throw new Error("--source is required: where this came from (path, URL, PR id, command)");
  // The same gate the MCP `memory_write` handler applies: ltm is durable,
  // verified knowledge, and the reason is the record of what verified it.
  if (tier === "ltm" && !input.reason?.trim()) {
    throw new Error("--reason is required for --tier ltm (why this is durable, verified knowledge)");
  }

  const shared = {
    db: session.db,
    embedder: session.embedder,
    repo: session.repo,
    input: { type: input.type as MemoryType, content: input.content, sources: input.sources },
  };
  if (tier === "ltm") {
    const r = await writeLtm({ ...shared, input: { ...shared.input, reason: input.reason as string } });
    return { id: r.id, tier, weight: r.weight };
  }
  const r = await writeStm(shared);
  return { id: r.id, tier, weight: r.weight };
}

export interface EpisodeInput {
  situation: string;
  action: string;
  expected: string;
  outcome: string;
  evidence?: string;
  actionType?: string;
}

export async function runEpisode(
  session: VerbSession,
  input: EpisodeInput
): Promise<{ id: string; weight: number }> {
  if (!input.situation.trim()) throw new Error("--situation must not be empty");
  if (!input.action.trim()) throw new Error("--action must not be empty");
  if (input.expected !== "success" && input.expected !== "failure") {
    throw new Error(`--expected must be success or failure (got ${JSON.stringify(input.expected)})`);
  }
  if (!(EPISODE_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new Error(`--outcome must be one of ${EPISODE_OUTCOMES.join("|")} (got ${JSON.stringify(input.outcome)})`);
  }
  const actionType = input.actionType ?? "other";
  if (!(ACTION_TYPES as readonly string[]).includes(actionType)) {
    throw new Error(`--action-type must be one of ${ACTION_TYPES.join("|")} (got ${JSON.stringify(actionType)})`);
  }

  const r = await writeEpisode({
    db: session.db,
    embedder: session.embedder,
    repo: session.repo,
    source: "cli",
    input: {
      situation: input.situation,
      action_type: actionType as ActionType,
      action_taken: input.action,
      expected: input.expected as EpisodeExpected,
      outcome: input.outcome as EpisodeOutcome,
      evidence: input.evidence ?? "",
      // Interactive shell work belongs to no epic and no dream cycle; the MCP
      // handler defaults the same two fields to the same two words.
      epic_id: "adhoc",
      cycle_id: UNTRACKED_CYCLE_ID,
    },
  });
  return { id: r.id, weight: r.weight };
}

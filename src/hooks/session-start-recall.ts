import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolvePaths } from "../paths.js";
import { buildMemoryContext } from "../memory/context.js";
import { recall, type RecallHit } from "../tools/memory/recall.js";
import { taskStateRead } from "../tools/memory/task-state-read.js";
import { Embedder } from "../ollama/embeddings.js";
import { OllamaClient } from "../ollama/client.js";
import type { MemoryDb } from "../memory/libsql-db.js";
import { readLatestHandoffBrief, buildHandoffSection } from "../memory/handoff-brief.js";
import { readLatestSessionSummary, buildLastSessionSection } from "./session-summary.js";
import { deriveDecisionCues, type TaskStateForCues } from "./decision-cues.js";

/**
 * SessionStart hook for interactive Claude Code: derive the repo, open the
 * repo-scoped memory replica, recall the durable project knowledge, and print a
 * compact digest to stdout so the harness injects it into the session — the
 * no-relearn bridge for non-daemon sessions.
 *
 * The digest itself is built by {@link buildDigestForCwd}, shared with the
 * daemon's `/digest` route: an always-on daemon answers over HTTP (the warm
 * path); when it is down the hook opens the local replica directly (the cold
 * path). Either way the process ALWAYS exits 0 within a hard deadline so session
 * start is never blocked (spec §8.4).
 *
 * Register in ~/.claude/settings.json:
 *   "hooks": { "SessionStart": [{ "hooks": [
 *     { "type": "command", "command": "node <dist>/hooks/session-start-recall.js" }
 *   ] }] }
 */

const STARTUP_CUES = [
  "codebase architecture",
  "operating philosophy",
  "open priorities",
  "deployment health check command",
  "known pitfalls and failure signatures",
];

/**
 * Cues for the semantic digest. With an active epic in task_state we derive
 * live cues (title, active plan step, touched files) and still append the fixed
 * cues for breadth; with no active epic we use the fixed cues alone.
 *
 * (Per the Task C0 trace-evidence gate: PROCEED-additive. If the gate chose
 * PROCEED-replace, return `dynamic` alone when it is non-empty.)
 */
export function chooseCues(taskState: TaskStateForCues | null): string[] {
  if (!taskState) return [...STARTUP_CUES];
  const dynamic = deriveDecisionCues({ taskState, boardCandidates: [] });
  const merged = [...dynamic];
  for (const c of STARTUP_CUES) if (!merged.includes(c)) merged.push(c);
  return merged;
}

/** Row types that get their own digest section (or are never embedded) and so
 *  must not also compete for the cue-recall lines. */
const DIGEST_EXCLUDED_TYPES = new Set(["session_summary", "handoff_brief", "task_state"]);

export function buildRecallDigest(repo: string, hits: RecallHit[]): string {
  hits = hits.filter((h) => !DIGEST_EXCLUDED_TYPES.has(h.type));
  if (hits.length === 0) return "";
  const lines = dedupeById(hits)
    .slice(0, 12)
    .map((h) => `- (${h.type}) ${h.content}`);
  return `## Project memory — ${repo}\n\nRecalled durable knowledge for this repo (do not relearn):\n${lines.join("\n")}`;
}

export function dedupeById(hits: RecallHit[]): RecallHit[] {
  const seen = new Set<string>();
  const out: RecallHit[] = [];
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Read the first active epic's plan state as cue inputs. Ported from the kairos
 * hook body: task_state_read with no epic_id lists every active epic; take the
 * first (null when none). The tool being unavailable falls back to fixed cues.
 */
async function readActiveTaskState(db: MemoryDb): Promise<TaskStateForCues | null> {
  try {
    const { active } = await taskStateRead({ db, input: {} });
    const epic = active[0];
    if (epic) return { title: epic.title, plan: epic.plan, touched: epic.touched };
  } catch {
    /* Layer 1 task_state tool unavailable — fall back to fixed cues */
  }
  return null;
}

/**
 * Build the repo-scoped recall digest for a workspace. Shared by the daemon
 * `/digest` route and the hook's cold path. Structural `{ db, embedder }` so the
 * hooks bundle never has to import the MCP server (server.ts reads
 * ../package.json relative to its own bundle, which breaks under dist/hooks/).
 * Each cue's recall is best-effort: a cue that errors (e.g. embedder
 * unavailable) is skipped so an empty/offline store yields "" rather than throwing.
 *
 * A handoff brief written by the daemon is prepended as the first section; a
 * store with no `handoff_brief` rows (any standalone install) adds nothing.
 */
export async function buildDigestForCwd(
  cwd: string,
  server: { db: MemoryDb; embedder: Embedder },
): Promise<string> {
  const taskState = await readActiveTaskState(server.db);
  const cues = chooseCues(taskState);
  const hits: RecallHit[] = [];
  for (const cue of cues) {
    try {
      hits.push(
        ...(await recall({
          db: server.db,
          embedder: server.embedder,
          caller: "session-start",
          input: { cue, k: 4 },
        })),
      );
    } catch {
      /* skip a cue that errors (e.g. embedder unavailable) */
    }
  }
  let handoffSection = "";
  try {
    handoffSection = buildHandoffSection(await readLatestHandoffBrief(server.db));
  } catch {
    /* no handoff yet — inject only the recall digest */
  }
  // The deterministic per-session summary written by the PreCompact/SessionEnd
  // hook: the "what was I doing" bridge for repos with no kairos epic.
  let lastSessionSection = "";
  try {
    lastSessionSection = buildLastSessionSection(await readLatestSessionSummary(server.db));
  } catch {
    /* none yet */
  }
  const digest = buildRecallDigest(server.db.repo || cwd, hits);
  return [handoffSection, lastSessionSection, digest].filter(Boolean).join("\n\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    // Hard deadline: whatever happens, never keep session start waiting > 5s.
    const deadline = setTimeout(() => process.exit(0), 5000);
    deadline.unref();

    const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

    // Warm path: the always-on daemon answers /digest. That route now requires
    // the bearer token (it exposes memory content), so read the token file and
    // send it. Any failure — unreadable token, daemon down, non-OK — falls
    // through to the cold path. 800ms budget.
    try {
      const paths = resolvePaths();
      const token = readFileSync(paths.tokenPath, "utf8").trim();
      const res = await fetch(
        `http://127.0.0.1:${paths.port}/digest?cwd=${encodeURIComponent(cwd)}`,
        { signal: AbortSignal.timeout(800), headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        const { digest } = (await res.json()) as { digest?: string };
        if (digest) process.stdout.write(digest);
        process.exit(0);
      }
      // Non-OK (e.g. 401/500) → fall through to the cold path.
    } catch {
      /* token unreadable or daemon down -> cold path */
    }

    // Cold path: open the local replica directly and build the digest here.
    try {
      const paths = resolvePaths();
      const ctx = await buildMemoryContext({
        workspaceCwd: cwd,
        embeddingModel: paths.embeddingModel,
        forceLocal: true,
        kairosHome: paths.home,
      });
      const client = new OllamaClient({ baseUrl: paths.ollamaUrl });
      const embedder = new Embedder({ client, model: paths.embeddingModel });
      const digest = await buildDigestForCwd(cwd, { db: ctx.db, embedder });
      if (digest) process.stdout.write(digest);
    } catch {
      /* never block session start */
    }
    process.exit(0);
  })();
}

import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../paths.js";
import { buildMemoryContext } from "../memory/context.js";
import { recall, type RecallHit } from "../tools/memory/recall.js";
import { Embedder } from "../ollama/embeddings.js";
import { OllamaClient } from "../ollama/client.js";

/**
 * UserPromptSubmit hook: ambient recall. Every prompt is a cue — the hits are
 * injected as `additionalContext` so recall no longer depends on the model
 * remembering to call `memory_recall` (transcript audit: ~1 call per 1,000
 * assistant turns when left to model judgment). Code decides, not the model.
 *
 * Warm path: the daemon's authenticated `/recall`. Cold path: open the local
 * replica. Either way the process ALWAYS exits 0 within a hard deadline so a
 * prompt is never held up; on any failure it injects nothing.
 *
 * Register in ~/.claude/settings.json under hooks.UserPromptSubmit (done by
 * `backant-memory install`).
 */

const MIN_PROMPT_CHARS = 12;
const MAX_CUE_CHARS = 600;
const K = 4;
const MAX_CONTENT_CHARS = 280;
const WARM_BUDGET_MS = 900;
const HARD_DEADLINE_MS = 2500;
const INJECTED_DIR = ".prompt-recall";
const INJECTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows injected at session start (or with no embedding) — never re-inject per prompt. */
const SKIP_TYPES = new Set(["handoff_brief", "task_state", "session_summary"]);
const TRIVIAL = new Set(["y", "yes", "no", "ok", "okay", "go", "continue", "proceed", "next", "thanks", "thank you", "done", "sure"]);

export function shouldRecallPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (!p || p.startsWith("/") || p.startsWith("!")) return false;
  if (p.length < MIN_PROMPT_CHARS) return false;
  if (TRIVIAL.has(p.toLowerCase().replace(/[.!]+$/, ""))) return false;
  return true;
}

/** Collapse whitespace and cap length so a pasted log doesn't become a 5k-token embedding. */
export function cueFromPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, MAX_CUE_CHARS);
}

export function formatAge(iso: string | undefined, now: Date): string {
  if (!iso) return "?";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "?";
  const d = Math.floor(ms / 86_400_000);
  if (d <= 0) return "today";
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/** Episodes are JSON; render situation → outcome instead of dumping the object. */
function renderContent(h: RecallHit): string {
  if (h.type === "episode") {
    try {
      const e = JSON.parse(h.content) as { situation?: string; action_taken?: string; outcome?: string; evidence?: string };
      const parts = [e.situation ?? "", e.action_taken ? `→ ${e.action_taken}` : "", e.outcome ? `(outcome: ${e.outcome}${e.evidence ? `; ${e.evidence}` : ""})` : ""];
      return truncate(parts.filter(Boolean).join(" ").replace(/\s+/g, " "), MAX_CONTENT_CHARS);
    } catch { /* fall through to raw */ }
  }
  return truncate(h.content.replace(/\s+/g, " "), MAX_CONTENT_CHARS);
}

export function formatPromptRecall(repo: string, hits: RecallHit[], now: Date): string {
  const usable = hits.filter((h) => !SKIP_TYPES.has(h.type) && h.content.trim().length > 0);
  if (usable.length === 0) return "";
  const lines = usable.map((h) => `- [${h.tier} · ${h.type} · ${formatAge(h.last_reinforced ?? h.created, now)}] ${renderContent(h)} (${h.id})`);
  return [
    `## Memory recall — ${repo} (automatic, backant-memory)`,
    "Stored knowledge matching this prompt; age = last reinforced. Older entries may be stale — verify before relying on them.",
    ...lines,
    "If one of these proves right, call memory_reinforce(id, 1.2, \"act-cite\"). Record new verified learnings with memory_write_ltm / memory_write_episode.",
  ].join("\n");
}

// ---- per-session injected-id memory -------------------------------------------

function injectedPath(dir: string, sessionId: string): string {
  return join(dir, INJECTED_DIR, sessionId.replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
}

function readInjected(dir: string, sessionId: string): Set<string> {
  try {
    const p = injectedPath(dir, sessionId);
    if (!existsSync(p)) return new Set();
    return new Set(JSON.parse(readFileSync(p, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

/** Drop hits already injected earlier in this session — the model has seen them. */
export function filterAlreadyInjected(dir: string, sessionId: string, hits: RecallHit[]): RecallHit[] {
  const seen = readInjected(dir, sessionId);
  return hits.filter((h) => !seen.has(h.id));
}

export function rememberInjected(dir: string, sessionId: string, hits: RecallHit[]): void {
  try {
    const seen = readInjected(dir, sessionId);
    for (const h of hits) seen.add(h.id);
    const p = injectedPath(dir, sessionId);
    mkdirSync(join(dir, INJECTED_DIR), { recursive: true });
    writeFileSync(p, JSON.stringify(Array.from(seen)));
    sweepInjected(join(dir, INJECTED_DIR));
  } catch {
    /* best-effort */
  }
}

/** Opportunistic cleanup: session files older than the TTL are removed. */
function sweepInjected(injDir: string): void {
  try {
    const cutoff = Date.now() - INJECTED_TTL_MS;
    for (const f of readdirSync(injDir)) {
      const p = join(injDir, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch { /* ignore */ }
}

// ---- hook entrypoint -----------------------------------------------------------

interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function emit(context: string): void {
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    const deadline = setTimeout(() => process.exit(0), HARD_DEADLINE_MS);
    deadline.unref();
    try {
      const input = JSON.parse((await readStdin()) || "{}") as HookInput;
      const prompt = input.prompt ?? "";
      if (!shouldRecallPrompt(prompt)) process.exit(0);
      const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      const sessionId = input.session_id ?? "unknown";
      const cue = cueFromPrompt(prompt);
      const paths = resolvePaths();
      const now = new Date();

      let hits: RecallHit[] | null = null;
      let repo = cwd;
      // Warm path: daemon /recall (bearer required — it exposes memory content).
      try {
        const token = readFileSync(paths.tokenPath, "utf8").trim();
        const url = `http://127.0.0.1:${paths.port}/recall?cwd=${encodeURIComponent(cwd)}&cue=${encodeURIComponent(cue)}&k=${K}&caller=prompt`;
        const res = await fetch(url, { signal: AbortSignal.timeout(WARM_BUDGET_MS), headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const j = (await res.json()) as { repo?: string; hits?: RecallHit[] };
          hits = j.hits ?? [];
          repo = j.repo ?? repo;
        }
      } catch { /* daemon down or slow → cold path */ }

      if (hits === null) {
        const ctx = await buildMemoryContext({ workspaceCwd: cwd, embeddingModel: paths.embeddingModel, forceLocal: true, kairosHome: paths.home });
        const client = new OllamaClient({ baseUrl: paths.ollamaUrl });
        const embedder = new Embedder({ client, model: paths.embeddingModel });
        hits = await recall({ db: ctx.db, embedder, caller: "prompt", input: { cue, k: K } });
        repo = ctx.db.repo || cwd;
      }

      const fresh = filterAlreadyInjected(paths.dbDir, sessionId, hits);
      const context = formatPromptRecall(repo, fresh, now);
      if (context) {
        emit(context);
        rememberInjected(paths.dbDir, sessionId, fresh);
      }
    } catch {
      /* never block a prompt */
    }
    process.exit(0);
  })();
}

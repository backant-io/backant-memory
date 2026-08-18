import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { resolvePaths } from "../paths.js";
import { buildMemoryContext } from "../memory/context.js";
import { embeddingToJson } from "../memory/embedding-util.js";
import type { MemoryDb } from "../memory/libsql-db.js";
import type { Embedder } from "../ollama/embeddings.js";
import { Embedder as OllamaEmbedder } from "../ollama/embeddings.js";
import { OllamaClient } from "../ollama/client.js";

/**
 * PreCompact + SessionEnd hook: close the write side deterministically.
 *
 * The transcript audit showed writes are the rarest memory op — they depend on
 * the model deciding, at the moment its context is most exhausted, that
 * something is worth recording. This hook needs no judgment: it parses the
 * session transcript (prompts, files touched, final outcome, branch) into one
 * `session_summary` STM row per session, upserted so PreCompact and SessionEnd
 * converge on a single row. The SessionStart digest then shows the latest one
 * as "Last session — resume here".
 *
 * The hook process hands the work to a detached worker and exits immediately
 * (SessionEnd's default budget is 1.5s), and never blocks or fails the session.
 */

const MIN_ASSISTANT_TURNS = 5;
const MAX_PROMPT_CHARS = 200;
const MAX_OUTCOME_CHARS = 400;
const MAX_TOUCHED = 12;
const HARD_DEADLINE_MS = 30_000;
const LATEST_MAX_AGE_DAYS = 21;

export interface SessionSummary {
  sessionId: string;
  reason: string;
  startedAt?: string;
  branch?: string;
  cwd?: string;
  prompts: string[];
  touched: string[];
  lastAssistantText?: string;
  assistantTurns: number;
  memoryOps: number;
  bashCommits: number;
}

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text?: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return "";
}

/** Pure: fold transcript JSONL lines into a summary; null when the session is too
 *  small to be worth a row. Ignores sidechains (subagents) and tool results. */
export function summarizeTranscript(
  lines: Iterable<string>,
  opts: { sessionId: string; reason: string },
): SessionSummary | null {
  const s: SessionSummary = {
    sessionId: opts.sessionId,
    reason: opts.reason,
    prompts: [],
    touched: [],
    assistantTurns: 0,
    memoryOps: 0,
    bashCommits: 0,
  };
  const touched = new Set<string>();
  for (const raw of lines) {
    if (!raw) continue;
    let o: TranscriptLine;
    try { o = JSON.parse(raw) as TranscriptLine; } catch { continue; }
    if (o.isSidechain) continue;
    if (o.gitBranch && !s.branch) s.branch = o.gitBranch;
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    if (o.type === "user") {
      const c = o.message?.content;
      const isToolResult = Array.isArray(c) && c.some((p) => p && typeof p === "object" && (p as { type?: string }).type === "tool_result");
      if (isToolResult) continue;
      const t = textOf(c).trim();
      if (t && !t.startsWith("<")) {
        if (!s.startedAt && o.timestamp) s.startedAt = o.timestamp;
        s.prompts.push(t.replace(/\s+/g, " ").slice(0, MAX_PROMPT_CHARS));
      }
      continue;
    }
    if (o.type === "assistant") {
      s.assistantTurns++;
      const parts = Array.isArray(o.message?.content) ? (o.message!.content as Array<Record<string, unknown>>) : [];
      for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
          s.lastAssistantText = p.text.trim().replace(/\s+/g, " ").slice(0, MAX_OUTCOME_CHARS);
        }
        if (p.type === "tool_use") {
          const name = String(p.name ?? "");
          const input = (p.input ?? {}) as Record<string, unknown>;
          if (name.startsWith("mcp__backant-memory__")) s.memoryOps++;
          if ((name === "Edit" || name === "Write" || name === "NotebookEdit") && typeof input.file_path === "string") touched.add(input.file_path);
          if (name === "Bash" && typeof input.command === "string" && /\bgit\s+commit\b/.test(input.command)) s.bashCommits++;
        }
      }
    }
  }
  s.touched = Array.from(touched);
  if (s.assistantTurns < MIN_ASSISTANT_TURNS || s.prompts.length === 0) return null;
  return s;
}

export function renderSessionSummary(s: SessionSummary, repo: string): string {
  const day = (s.startedAt ?? new Date().toISOString()).slice(0, 10);
  const where = s.branch ? `${repo}@${s.branch}` : repo;
  const lines: string[] = [];
  lines.push(`Session ${day} on ${where} (${s.assistantTurns} turns, ended: ${s.reason}).`);
  const first = s.prompts[0];
  const last = s.prompts.length > 1 ? s.prompts[s.prompts.length - 1] : undefined;
  lines.push(`Asked: ${first}${last ? ` … last: ${last}` : ""}`);
  if (s.touched.length) {
    const shown = s.touched.slice(0, MAX_TOUCHED).map((p) => basename(p));
    const more = s.touched.length > MAX_TOUCHED ? ` +${s.touched.length - MAX_TOUCHED} more` : "";
    lines.push(`Touched: ${shown.join(", ")}${more}${s.bashCommits ? ` · ${s.bashCommits} commit(s)` : ""}`);
  }
  if (s.lastAssistantText) lines.push(`Outcome: ${s.lastAssistantText}`);
  lines.push(`Memory ops this session: ${s.memoryOps}`);
  return lines.join("\n");
}

/** Deterministic per-session id so PreCompact and SessionEnd upsert the same row. */
export function sessionSummaryId(startedAtIso: string, sessionId: string): string {
  const h = createHash("sha1").update(sessionId).digest("hex").slice(0, 8);
  return `stm_${startedAtIso.slice(0, 10)}_ss${h}`;
}

export async function upsertSessionSummary(deps: {
  db: MemoryDb;
  embedder: Embedder;
  sessionId: string;
  event: string;
  content: string;
  repo?: string;
  startedAt?: string;
  now?: () => Date;
}): Promise<{ id: string; updated: boolean }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const repo = deps.repo ?? deps.db.repo;
  const id = sessionSummaryId(deps.startedAt ?? now, deps.sessionId);
  const embedding = embeddingToJson(await deps.embedder.embed(deps.content));
  const sources = JSON.stringify([`session:${deps.sessionId}`, `hook:${deps.event}`]);
  const existing = await deps.db.get<{ id: string }>("SELECT id FROM memory WHERE id = ?", [id]);
  if (existing) {
    await deps.db.batch([
      { sql: "UPDATE memory SET content = ?, sources = ?, last_reinforced = ?, embedding = vector32(?) WHERE id = ?", args: [deps.content, sources, now, embedding, id] },
      { sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)", args: [id] },
      { sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)", args: [id, deps.content] },
    ]);
    return { id, updated: true };
  }
  await deps.db.batch([
    {
      sql: `INSERT INTO memory
              (id, repo, tier, type, content, sources, weight, created, last_reinforced,
               dream_citations, act_citations, revision_count, embedding)
            VALUES (?, ?, 'stm', 'session_summary', ?, ?, 1.0, ?, ?, 0, 0, 0, vector32(?))`,
      args: [id, repo, deps.content, sources, now, now, embedding],
    },
    { sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)", args: [id, deps.content] },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp) VALUES ('untracked', 'session_summary', ?, ?, ?)`,
      args: [JSON.stringify({ session_id: deps.sessionId, event: deps.event }), JSON.stringify({ id }), now],
    },
  ]);
  return { id, updated: false };
}

/** Latest session summary for the repo, or null when none is recent enough. */
export async function readLatestSessionSummary(
  db: MemoryDb,
  repo?: string,
  now: () => Date = () => new Date(),
): Promise<{ id: string; content: string; last_reinforced: string } | null> {
  const r = repo ?? db.repo;
  const row = await db.get<{ id: string; content: string; last_reinforced: string }>(
    "SELECT id, content, last_reinforced FROM memory WHERE repo = ? AND type = 'session_summary' ORDER BY last_reinforced DESC LIMIT 1",
    [r],
  );
  if (!row) return null;
  const ageDays = (now().getTime() - new Date(row.last_reinforced).getTime()) / 86_400_000;
  return ageDays <= LATEST_MAX_AGE_DAYS ? row : null;
}

export function buildLastSessionSection(row: { content: string } | null): string {
  if (!row) return "";
  return `## Last session — resume here (auto-summary)\n\n${row.content}`;
}

// ---- hook entrypoint -----------------------------------------------------------

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
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

async function readLines(path: string): Promise<string[]> {
  const out: string[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const l of rl) out.push(l);
  return out;
}

async function work(input: HookInput): Promise<void> {
  if (!input.transcript_path || !input.session_id) return;
  const lines = await readLines(input.transcript_path);
  const summary = summarizeTranscript(lines, { sessionId: input.session_id, reason: input.reason ?? input.hook_event_name ?? "unknown" });
  if (!summary) return;
  const cwd = input.cwd ?? summary.cwd ?? process.cwd();
  const paths = resolvePaths();
  const ctx = await buildMemoryContext({ workspaceCwd: cwd, embeddingModel: paths.embeddingModel, forceLocal: true, kairosHome: paths.home });
  const client = new OllamaClient({ baseUrl: paths.ollamaUrl });
  const embedder = new OllamaEmbedder({ client, model: paths.embeddingModel });
  const content = renderSessionSummary(summary, ctx.db.repo || cwd);
  await upsertSessionSummary({ db: ctx.db, embedder, sessionId: input.session_id, event: input.hook_event_name ?? "SessionEnd", content, startedAt: summary.startedAt });
  await ctx.db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    if (process.argv.includes("--worker")) {
      const deadline = setTimeout(() => process.exit(0), HARD_DEADLINE_MS);
      deadline.unref();
      try { await work(JSON.parse(process.env.BACKANT_SESSION_SUMMARY_INPUT ?? "{}") as HookInput); } catch { /* best-effort */ }
      process.exit(0);
    }
    // Hook mode: hand off to a detached worker and return immediately so the
    // session's exit (or compaction) is never held up by embedding/DB work.
    try {
      const raw = (await readStdin()) || "{}";
      const child = spawn(process.execPath, [process.argv[1]!, "--worker"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, BACKANT_SESSION_SUMMARY_INPUT: raw },
      });
      child.unref();
    } catch { /* never fail the hook */ }
    process.exit(0);
  })();
}

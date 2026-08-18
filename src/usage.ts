import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * `backant-memory usage` — measure adoption from Claude Code transcripts instead
 * of inferring it from store size. Pure aggregation over one summary per
 * session; the scanner streams JSONL so a multi-GB projects dir is fine.
 *
 * Reads only: never writes to the transcripts or the store.
 */

const MEMORY_PREFIX = "mcp__backant-memory__";
const DIGEST_MARKERS = ["## Project memory", "Handoff — resume here", "Last session — resume here"];

export interface SessionUsage {
  project: string;
  entrypoint: string;
  assistantTurns: number;
  userPrompts: number;
  memoryCalls: Record<string, number>;
  toolSearchMemory: number;
  sessionStartHook: boolean;
  digestInjected: boolean;
  firstTimestamp?: string;
}

/** Pure: fold one transcript's JSONL lines into a session summary. */
export function summarizeSessionLines(lines: Iterable<string>, project: string): SessionUsage {
  const s: SessionUsage = {
    project,
    entrypoint: "unknown",
    assistantTurns: 0,
    userPrompts: 0,
    memoryCalls: {},
    toolSearchMemory: 0,
    sessionStartHook: false,
    digestInjected: false,
  };
  let entrySeen = false;
  for (const raw of lines) {
    if (!raw) continue;
    let o: any;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!entrySeen && typeof o.entrypoint === "string") { s.entrypoint = o.entrypoint; entrySeen = true; }
    const att = o.attachment;
    if (att && typeof att === "object" && String(att.hookName ?? "").startsWith("SessionStart")) {
      s.sessionStartHook = true;
      const blob = JSON.stringify(att);
      if (DIGEST_MARKERS.some((m) => blob.includes(m))) s.digestInjected = true;
    }
    if (o.isSidechain) continue;
    if (o.type === "user") {
      const c = o.message?.content;
      const isToolResult = Array.isArray(c) && c.some((p: any) => p && p.type === "tool_result");
      if (!isToolResult) s.userPrompts++;
      continue;
    }
    if (o.type === "assistant") {
      s.assistantTurns++;
      if (!s.firstTimestamp && typeof o.timestamp === "string") s.firstTimestamp = o.timestamp;
      const parts = Array.isArray(o.message?.content) ? o.message.content : [];
      for (const p of parts) {
        if (!p || p.type !== "tool_use") continue;
        const name = String(p.name ?? "");
        if (name.startsWith(MEMORY_PREFIX)) {
          const short = name.slice(MEMORY_PREFIX.length);
          s.memoryCalls[short] = (s.memoryCalls[short] ?? 0) + 1;
        } else if (name === "ToolSearch" && JSON.stringify(p.input ?? {}).includes("backant-memory")) {
          s.toolSearchMemory++;
        }
      }
    }
  }
  return s;
}

export interface EntrypointRow {
  entrypoint: string;
  sessions: number;
  hookSeen: number;
  digestInjected: number;
  usedMemory: number;
  recalled: number;
  wrote: number;
  needededToolSearch: number;
}

export interface UsageReport {
  minTurns: number;
  totalSessions: number;
  byEntrypoint: EntrypointRow[];
  memoryCallsByName: Record<string, number>;
  totalAssistantTurns: number;
  totalMemoryCalls: number;
  callsPer1kTurns: number;
  topProjects: Array<{ project: string; sessions: number; usedMemory: number }>;
}

// Legacy and consolidated names. `procedure`/`task_state` take an action we
// don't see here, so they count on both sides — a slight over-count, stated.
const WRITE_TOOLS = new Set(["memory_write", "memory_write_stm", "memory_write_ltm", "memory_write_episode", "procedure_propose", "task_state_write", "procedure", "task_state"]);
const RECALL_TOOLS = new Set(["memory_recall", "memory_recall_with_edges", "memory_recall_by_id", "procedure_grounding", "procedure", "task_state_read", "task_state"]);

export function aggregateUsage(sessions: SessionUsage[], opts: { minTurns?: number } = {}): UsageReport {
  const minTurns = opts.minTurns ?? 10;
  const kept = sessions.filter((s) => s.assistantTurns >= minTurns);
  const rows = new Map<string, EntrypointRow>();
  const byName: Record<string, number> = {};
  const projects = new Map<string, { sessions: number; usedMemory: number }>();
  let turns = 0;
  let calls = 0;
  for (const s of kept) {
    const r = rows.get(s.entrypoint) ?? { entrypoint: s.entrypoint, sessions: 0, hookSeen: 0, digestInjected: 0, usedMemory: 0, recalled: 0, wrote: 0, needededToolSearch: 0 };
    r.sessions++;
    if (s.sessionStartHook) r.hookSeen++;
    if (s.digestInjected) r.digestInjected++;
    const names = Object.keys(s.memoryCalls);
    const n = Object.values(s.memoryCalls).reduce((a, b) => a + b, 0);
    if (n > 0) r.usedMemory++;
    if (names.some((x) => RECALL_TOOLS.has(x))) r.recalled++;
    if (names.some((x) => WRITE_TOOLS.has(x))) r.wrote++;
    if (n > 0 && s.toolSearchMemory > 0) r.needededToolSearch++;
    rows.set(s.entrypoint, r);
    for (const [k, v] of Object.entries(s.memoryCalls)) byName[k] = (byName[k] ?? 0) + v;
    turns += s.assistantTurns;
    calls += n;
    const p = projects.get(s.project) ?? { sessions: 0, usedMemory: 0 };
    p.sessions++;
    if (n > 0) p.usedMemory++;
    projects.set(s.project, p);
  }
  return {
    minTurns,
    totalSessions: kept.length,
    byEntrypoint: Array.from(rows.values()).sort((a, b) => b.sessions - a.sessions),
    memoryCallsByName: byName,
    totalAssistantTurns: turns,
    totalMemoryCalls: calls,
    callsPer1kTurns: turns > 0 ? (calls / turns) * 1000 : 0,
    topProjects: Array.from(projects.entries()).map(([project, v]) => ({ project, ...v })).sort((a, b) => b.sessions - a.sessions).slice(0, 10),
  };
}

export function renderUsageReport(r: UsageReport, opts: { days?: number } = {}): string {
  const out: string[] = [];
  out.push(`backant-memory usage — ${r.totalSessions} sessions with ≥${r.minTurns} assistant turns${opts.days ? ` in the last ${opts.days} days` : ""}`);
  out.push("");
  out.push(pad(["entrypoint", "sessions", "hook ran", "digest", "used memory", "recalled", "wrote", "via ToolSearch"]));
  for (const e of r.byEntrypoint) {
    out.push(pad([e.entrypoint, e.sessions, e.hookSeen, e.digestInjected, e.usedMemory, e.recalled, e.wrote, e.needededToolSearch]));
  }
  out.push("");
  out.push(`memory calls: ${r.totalMemoryCalls} over ${r.totalAssistantTurns} assistant turns → ${r.callsPer1kTurns.toFixed(1)} per 1k assistant turns`);
  const names = Object.entries(r.memoryCallsByName).sort((a, b) => b[1] - a[1]);
  if (names.length) out.push("by tool: " + names.map(([k, v]) => `${k}=${v}`).join(", "));
  if (r.topProjects.length) {
    out.push("");
    out.push("top projects (sessions / used memory):");
    for (const p of r.topProjects) out.push(`  ${p.sessions}\t${p.usedMemory}\t${p.project}`);
  }
  out.push("");
  out.push("Note: 'via ToolSearch' counts sessions that had to load the tools before using them (deferred MCP). `backant-memory install` sets alwaysLoad to remove that step.");
  return out.join("\n");
}

function pad(cells: Array<string | number>): string {
  const widths = [14, 9, 9, 8, 12, 9, 6, 14];
  return cells.map((c, i) => String(c).padEnd(widths[i] ?? 8)).join(" ").trimEnd();
}

/** Stream every transcript under `projectsDir` modified since `sinceMs`. */
export async function scanTranscripts(opts: { projectsDir?: string; sinceMs: number } ): Promise<SessionUsage[]> {
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude/projects");
  const out: SessionUsage[] = [];
  let projects: string[] = [];
  try { projects = readdirSync(projectsDir); } catch { return out; }
  for (const proj of projects) {
    const dir = join(projectsDir, proj);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < opts.sinceMs) continue;
      } catch { continue; }
      const lines: string[] = [];
      const rl = createInterface({ input: createReadStream(p, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const l of rl) lines.push(l);
      out.push(summarizeSessionLines(lines, basename(dirname(p))));
    }
  }
  return out;
}

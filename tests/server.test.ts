import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryServer, CORE_TOOL_NAMES, LEGACY_TOOL_NAMES } from "../src/server.js";
import type { Embedder } from "../src/ollama/embeddings.js";

const fakeEmbedder = { embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]) } as unknown as Embedder;

const LEGACY_24 = [
  "memory_write_stm", "memory_write_ltm", "memory_write_episode",
  "memory_recall", "memory_recall_with_edges", "memory_recall_by_id",
  "memory_recall_by_edge", "memory_pattern_check",
  "memory_revise_ltm", "memory_reinforce", "memory_promote", "memory_demote",
  "memory_decay_sweep", "memory_bump_verdict_boost",
  "memory_edge_propose", "memory_edge_approve", "memory_edge_reject", "edges_pending",
  "task_state_write", "task_state_read",
  "procedure_propose", "procedure_outcome", "procedure_sweep", "procedure_grounding",
].sort();

const CORE_9 = [
  "memory_recall", "memory_write", "memory_write_episode", "memory_reinforce",
  "memory_edit", "memory_graph", "procedure", "task_state", "memory_maintain",
].sort();

async function srv(profile?: "core" | "full") {
  const dir = mkdtempSync(join(tmpdir(), "bam-"));
  return buildMemoryServer({ workspaceCwd: dir, memoryDbPath: join(dir, "m.db"), toolProfile: profile, embedder: fakeEmbedder });
}

describe("buildMemoryServer tool profiles", () => {
  // WHY: 25 tools with overlapping triggers is a surface the model under-uses;
  // 9 trigger-first tools is the interactive default. The legacy names must stay
  // reachable ("keep the legacy MCP open") for HTTP clients and old configs.
  it("core exposes exactly the 9 consolidated tools", async () => {
    const s = await srv("core");
    expect(s.listToolNames().sort()).toEqual(CORE_9);
    expect([...CORE_TOOL_NAMES].sort()).toEqual(CORE_9);
  });

  it("full exposes core + every legacy name (all 24 previous tools still callable), and is the default", async () => {
    const s = await srv("full");
    const names = s.listToolNames();
    for (const n of LEGACY_24) expect(names).toContain(n);
    for (const n of CORE_9) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);           // no duplicate registrations
    expect([...LEGACY_TOOL_NAMES].every((n) => LEGACY_24.includes(n))).toBe(true);
    const d = await srv();
    expect(d.listToolNames().length).toBe(names.length);
  });

  it("has no kairos-cycle wording in tool descriptions", async () => {
    const s = await srv("full");
    for (const d of s.listToolDescriptions()) {
      expect(d).not.toMatch(/wake-judge|kairos-act|kairos-retry|kairos-observe|kairos-plan-epic|dream pipeline|Dream-only/i);
    }
  });
});

describe("consolidated tool dispatch", () => {
  it("memory_write routes by tier, requires a reason for ltm, and memory_recall returns {hits} with a nudge when empty", async () => {
    const s = await srv("core");
    const empty = (await s.callTool("memory_recall", { cue: "anything at all" })) as any;
    expect(empty.hits).toEqual([]);
    expect(empty.note).toMatch(/no memories/i);
    await expect(s.callTool("memory_write", { tier: "ltm", type: "lesson", content: "x", sources: [] })).rejects.toThrow(/reason/);
    const stm = (await s.callTool("memory_write", { tier: "stm", type: "observation", content: "flaky test in ci on arm64", sources: ["ci"] })) as any;
    expect(stm.id.startsWith("stm_")).toBe(true);
    const ltm = (await s.callTool("memory_write", { tier: "ltm", type: "lesson", content: "always run make health before deploy", sources: ["runbook"], reason: "verified twice" })) as any;
    expect(ltm.id).toMatch(/^ltm_.*lesson_\d+$/);
    const r = (await s.callTool("memory_recall", { cue: "deploy health", k: 5 })) as any;
    expect(r.hits.length).toBe(2);
    expect(r.note).toBeUndefined();
    // by id
    const one = (await s.callTool("memory_recall", { cue: "", id: ltm.id })) as any;
    expect(one.hits[0].id).toBe(ltm.id);
    // with edges walk still works
    const we = (await s.callTool("memory_recall", { cue: "deploy", with_edges: true, edge_depth: 1 })) as any;
    expect(Array.isArray(we.hits)).toBe(true);
  });

  it("memory_edit revises/promotes/demotes; memory_reinforce defaults; memory_maintain sweeps", async () => {
    const s = await srv("core");
    const stm = (await s.callTool("memory_write", { tier: "stm", type: "observation", content: "obs", sources: [] })) as any;
    const promoted = (await s.callTool("memory_edit", { action: "promote", id: stm.id, reason: "confirmed" })) as any;
    expect(promoted.ltm_id).toMatch(/^ltm_.*observation_\d+$/);
    const revised = (await s.callTool("memory_edit", { action: "revise", id: promoted.ltm_id, new_content: "obs v2", reason: "clarified" })) as any;
    expect(revised.new_version).toBe(1);
    const reinforced = (await s.callTool("memory_reinforce", { id: promoted.ltm_id })) as any;   // factor/reason default
    expect(reinforced.new_weight).toBeGreaterThan(0);
    const demoted = (await s.callTool("memory_edit", { action: "demote", id: promoted.ltm_id, reason: "contradicted" })) as any;
    expect(demoted.stm_id ?? demoted.id).toBeTruthy();
    const sweep = (await s.callTool("memory_maintain", { action: "decay_sweep" })) as any;
    expect(typeof sweep.decayed_n).toBe("number");
    const pat = (await s.callTool("memory_maintain", { action: "pattern_check", domains: ["ci"] })) as any;
    expect(pat.ci).toBeDefined();
    await expect(s.callTool("memory_edit", { action: "nope", id: "x", reason: "r" })).rejects.toThrow(/action/);
  });

  it("task_state read/write, memory_graph pending/list, procedure sweep dispatch", async () => {
    const s = await srv("core");
    await s.callTool("task_state", { action: "write", epic_id: "e1", title: "T", status: "active", plan: [{ step: "a", status: "active" }], open_threads: [], touched: [], blockers: [] });
    const ts = (await s.callTool("task_state", { action: "read" })) as any;
    expect(ts.active[0].epic_id).toBe("e1");
    const pending = (await s.callTool("memory_graph", { action: "pending" })) as any;
    expect(Array.isArray(pending.edges ?? pending)).toBe(true);
    const listed = (await s.callTool("memory_graph", { action: "list" })) as any;
    expect(Array.isArray(listed.edges ?? listed)).toBe(true);
    const sw = (await s.callTool("procedure", { action: "sweep" })) as any;
    expect(typeof sw.scanned).toBe("number");
    // legacy name still answers in full profile
    const f = await srv("full");
    const legacy = (await f.callTool("task_state_read", {})) as any;
    expect(Array.isArray(legacy.active)).toBe(true);
    // episode without epic/cycle in core
    const ep = (await s.callTool("memory_write_episode", { situation: "s", action_type: "fix", action_taken: "a", expected: "success", outcome: "failure", evidence: "e" })) as any;
    expect(ep.weight).toBe(2);
  });
});

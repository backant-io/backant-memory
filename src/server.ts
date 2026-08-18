import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryDb } from "./memory/libsql-db.js";

import { openMemoryDb } from "./memory/libsql-db.js";
import { OllamaClient } from "./ollama/client.js";
import { Embedder } from "./ollama/embeddings.js";

import {
  writeStm,
  writeLtm,
  recall,
  recallWithEdges,
  recallById,
  recallByEdge,
  patternCheck,
  reviseLtm,
  reinforce,
  promote,
  demote,
  decaySweep,
  taskStateWrite,
  taskStateRead,
  writeEpisode,
  procedurePropose,
  procedureOutcome,
  bumpVerdictBoost,
  edgePropose,
  edgeApprove,
  edgeReject,
  edgesPending,
  procedureSweep,
  procedureGrounding,
} from "./tools/index.js";
import { UNTRACKED_CYCLE_ID } from "./memory/constants.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export interface MemoryTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (input: unknown) => Promise<unknown>;
}

/** Which tool surface a server exposes.
 *  - `core`: 9 consolidated, trigger-first tools — the interactive default
 *    (Claude Code stdio). Fewer, sharper tools get used; the transcript audit
 *    showed 25 overlapping ones mostly didn't.
 *  - `full`: core + every legacy tool name unchanged, for HTTP clients and any
 *    config that predates the consolidation. Default for library callers. */
export type ToolProfile = "core" | "full";

export const CORE_TOOL_NAMES = [
  "memory_recall", "memory_write", "memory_write_episode", "memory_reinforce",
  "memory_edit", "memory_graph", "procedure", "task_state", "memory_maintain",
] as const;

export const LEGACY_TOOL_NAMES = [
  "memory_write_stm", "memory_write_ltm", "memory_recall_with_edges", "memory_recall_by_id",
  "memory_recall_by_edge", "memory_pattern_check", "memory_revise_ltm", "memory_promote",
  "memory_demote", "memory_decay_sweep", "memory_bump_verdict_boost", "memory_edge_propose",
  "memory_edge_approve", "memory_edge_reject", "edges_pending", "task_state_write",
  "task_state_read", "procedure_propose", "procedure_outcome", "procedure_sweep",
  "procedure_grounding",
] as const;

interface BuildOptions {
  workspaceCwd: string;
  memoryDbPath?: string;
  ollamaUrl?: string;
  embeddingModel?: string;
  /** Repo key (owner/repo) this server's memory is scoped to. */
  repo?: string;
  /** Pre-opened memory db (used by buildMemoryContext in boot wiring). */
  db?: MemoryDb;
  /** Pre-built embedder (tests inject an offline fake). */
  embedder?: Embedder;
  /** Tool surface; defaults to "full" so library callers see no change. */
  toolProfile?: ToolProfile;
}

export interface MemoryServer {
  listToolNames(): string[];
  listToolDescriptions(): string[];
  callTool(name: string, input: unknown): Promise<unknown>;
  db: MemoryDb;
  embedder: Embedder;
  toolProfile: ToolProfile;
  createMcpServer(): Server;
  startStdio(): Promise<Server>;
}

const ACTION_TYPE_ENUM = ["fix", "merge", "implement", "review-feedback", "migrate", "investigate", "other"];
const OUTCOME_ENUM = ["success", "failure", "partial"];

const WRITE_EXCLUSIONS =
  "Do NOT write restatements of the diff, file listings, generic language/framework facts, or anything greppable from the repo. " +
  "Write what is NOT derivable from the code: decisions and why, verified commands, gotchas, failure signatures, conventions the team agreed.";

function requireAction<T extends string>(input: any, allowed: readonly T[]): T {
  const a = input?.action;
  if (!allowed.includes(a)) throw new Error(`action must be one of ${allowed.join("|")} (got ${JSON.stringify(a)})`);
  return a;
}

export async function buildMemoryServer(opts: BuildOptions): Promise<MemoryServer> {
  const { workspaceCwd } = opts;
  const memoryDbPath = opts.memoryDbPath
    ?? join(homedir(), ".claude/kairos/memory/.index.db");
  const ollamaUrl = opts.ollamaUrl ?? "http://127.0.0.1:11434";
  const embeddingModel = opts.embeddingModel ?? "qwen3-embedding:0.6b";
  const toolProfile: ToolProfile = opts.toolProfile ?? "full";

  const db: MemoryDb = opts.db ?? (await openMemoryDb({ localPath: memoryDbPath, repo: opts.repo ?? "" }));
  const embedder = opts.embedder ?? new Embedder({ client: new OllamaClient({ baseUrl: ollamaUrl }), model: embeddingModel });

  // ---- shared handlers (one implementation per operation; both surfaces dispatch here) ----
  const h = {
    writeStm: async (input: any) => writeStm({ db, embedder, input }),
    writeLtm: async (input: any) => {
      if (!input?.reason || !String(input.reason).trim()) throw new Error("ltm writes require a reason (why this is durable, verified knowledge)");
      return writeLtm({ db, embedder, input });
    },
    recall: async (input: any) => recall({ db, embedder, caller: "agent", input }),
    recallWithEdges: async (input: any) => recallWithEdges({ db, embedder, input }),
    recallById: async (input: any) => recallById({ db, id: input.id }),
    recallByEdge: async (input: any) => recallByEdge({ db, input }),
    patternCheck: async (input: any) => patternCheck({ db, input }),
    reviseLtm: async (input: any) => reviseLtm({ db, embedder, dream_source_id: null, ...input }),
    reinforce: async (input: any) => reinforce({ db, id: input.id, factor: input.factor ?? 1.2, reason: input.reason ?? "act-cite" }),
    promote: async (input: any) => promote({ db, stm_id: input.stm_id ?? input.id, reason: input.reason }),
    demote: async (input: any) => demote({ db, ltm_id: input.ltm_id ?? input.id, reason: input.reason }),
    decaySweep: async () => decaySweep({ db }),
    taskStateWrite: async (input: any) => taskStateWrite({ db, embedder, input }),
    taskStateRead: async (input: any) => taskStateRead({ db, input: input ?? {} }),
    writeEpisode: async (input: any) => writeEpisode({
      db, embedder, source: input.source,
      input: { ...input, epic_id: input.epic_id ?? "adhoc", cycle_id: input.cycle_id ?? UNTRACKED_CYCLE_ID },
    }),
    edgePropose: async (input: any) => edgePropose({ db, input }),
    edgeApprove: async (input: any) => edgeApprove({ db, edge_id: input.edge_id, approver_cycle: input.approver_cycle ?? UNTRACKED_CYCLE_ID }),
    edgeReject: async (input: any) => edgeReject({ db, edge_id: input.edge_id, reason: input.reason }),
    edgesPending: async (input: any) => edgesPending({ db, input: input ?? {} }),
    procedurePropose: async (input: any) => procedurePropose({ db, embedder, cwd: workspaceCwd, input }),
    procedureOutcome: async (input: any) => procedureOutcome({ db, embedder, input: { ...input, cycle_id: input.cycle_id ?? UNTRACKED_CYCLE_ID } }),
    procedureSweep: async (input: any) => procedureSweep({ db, cwd: workspaceCwd, cycleId: input?.cycleId ?? input?.cycle_id ?? UNTRACKED_CYCLE_ID }),
    procedureGrounding: async (input: any) => procedureGrounding({ db, embedder, input }),
    bumpVerdictBoost: async (input: any) => bumpVerdictBoost({ db, id: input.id, reason: input.reason, cycleId: input?.cycleId }),
  };

  // ---- core: 9 consolidated tools ----------------------------------------------
  const core: MemoryTool[] = [
    {
      name: "memory_recall",
      description:
        "Recall stored knowledge for this repo (hybrid BM25 + vector + weight + recency). An automatic recall already runs on every prompt; call this for a DIFFERENT angle, a deeper k, a specific id, or to walk relationships (with_edges). " +
        "Use before re-deriving anything that may have history. Returns {hits, count, note?}; hits carry tier, type, age (last_reinforced) and id — older hits may be stale.",
      inputSchema: { type: "object", required: ["cue"], properties: {
        cue: { type: "string", description: "short cue, e.g. 'auth token refresh bug' (ignored when id is given)" },
        k: { type: "number" }, tier: { type: "string", enum: ["any", "stm", "ltm"] },
        types: { type: "array", items: { type: "string" } },
        id: { type: "string", description: "fetch one entry by id instead of searching" },
        with_edges: { type: "boolean", description: "also walk approved edges from each hit" },
        edge_depth: { type: "number" },
      } },
      handler: async (input: any) => {
        if (input?.id) {
          const one = await h.recallById(input);
          return { hits: one ? [one] : [], count: one ? 1 : 0, ...(one ? {} : { note: `no memory with id ${input.id}` }) };
        }
        const hits = input?.with_edges ? await h.recallWithEdges(input) : await h.recall(input);
        return hits.length > 0
          ? { hits, count: hits.length }
          : { hits: [], count: 0, note: "No memories match in this repo yet. When you learn something not derivable from the code, write it with memory_write (or memory_write_episode for an attempt)." };
      },
    },
    {
      name: "memory_write",
      description:
        "Write a memory for this repo. tier='stm' for observations, hypotheses, anomalies, retries (decays unless reinforced); tier='ltm' ONLY for verified, durable knowledge — after a confirmed outcome or decision, with a reason. " +
        WRITE_EXCLUSIONS + " Check memory_recall first so you reinforce an existing entry instead of duplicating it.",
      inputSchema: { type: "object", required: ["tier", "type", "content", "sources"], properties: {
        tier: { type: "string", enum: ["stm", "ltm"] },
        type: { type: "string", description: "observation|hypothesis|anomaly|retry|failure_signature|architecture|lesson|principle|priority|product-fact|convention|gotcha|..." },
        content: { type: "string" },
        sources: { type: "array", items: { type: "string" }, description: "where this came from: file paths, PR/issue ids, commands, URLs" },
        reason: { type: "string", description: "required for ltm: why this is durable and verified" },
      } },
      handler: async (input: any) => (input?.tier === "ltm" ? h.writeLtm(input) : h.writeStm(input)),
    },
    {
      name: "memory_write_episode",
      description:
        "Record an attempt at a decision point: what the situation was, what you did, what you expected vs what happened, and the evidence. Weight is surprise-scaled (mismatch = 2x). Call after each meaningful action, especially failures and surprises. " +
        "epic_id/cycle_id are optional (default adhoc/untracked) for interactive work.",
      inputSchema: { type: "object", required: ["situation", "action_type", "action_taken", "expected", "outcome", "evidence"], properties: {
        situation: { type: "string" },
        action_type: { type: "string", enum: ACTION_TYPE_ENUM },
        action_taken: { type: "string" },
        expected: { type: "string", enum: ["success", "failure"] },
        outcome: { type: "string", enum: OUTCOME_ENUM },
        evidence: { type: "string" },
        epic_id: { type: "string" }, cycle_id: { type: "string" },
        source: { type: "string" },
      } },
      handler: h.writeEpisode,
    },
    {
      name: "memory_reinforce",
      description:
        "A recalled memory proved right/useful in practice: bump its weight and citation (reason 'act-cite' also raises its ranking boost). Call this when a hit from an automatic or manual recall guided a correct action. factor defaults to 1.2, reason to 'act-cite'.",
      inputSchema: { type: "object", required: ["id"], properties: {
        id: { type: "string" }, factor: { type: "number" }, reason: { type: "string", description: "'act-cite' (default) | 'dream-cite' | free text" },
      } },
      handler: h.reinforce,
    },
    {
      name: "memory_edit",
      description:
        "Change an existing memory's standing. action='revise': rewrite an LTM entry's content with an audit trail (needs new_content). action='promote': STM→LTM once evidence accumulated. action='demote': LTM→STM for revalidation when contradicted. Always give a reason.",
      inputSchema: { type: "object", required: ["action", "id", "reason"], properties: {
        action: { type: "string", enum: ["revise", "promote", "demote"] },
        id: { type: "string" }, new_content: { type: "string" }, reason: { type: "string" },
      } },
      handler: async (input: any) => {
        const a = requireAction(input, ["revise", "promote", "demote"] as const);
        if (a === "revise") return h.reviseLtm({ id: input.id, new_content: input.new_content, reason: input.reason });
        if (a === "promote") return h.promote(input);
        return h.demote(input);
      },
    },
    {
      name: "memory_graph",
      description:
        "Relationships between memories (typed edges: related_to|contradicts|supports|supersedes|refines). action='propose' (from,to,type,reason) — lands as proposed; 'approve' (edge_id) — approving a supersedes edge invalidates the superseded entry; 'reject' (edge_id, reason); 'pending' — list proposals; 'list' (from?,to?,type?) — approved edges.",
      inputSchema: { type: "object", required: ["action"], properties: {
        action: { type: "string", enum: ["propose", "approve", "reject", "pending", "list"] },
        from: { type: "string" }, to: { type: "string" }, type: { type: "string" }, reason: { type: "string" },
        edge_id: { type: "number" }, approver_cycle: { type: "string" }, limit: { type: "number" },
        dream_source_id: { type: ["string", "null"] },
      } },
      handler: async (input: any) => {
        const a = requireAction(input, ["propose", "approve", "reject", "pending", "list"] as const);
        if (a === "propose") return h.edgePropose(input);
        if (a === "approve") return h.edgeApprove(input);
        if (a === "reject") return h.edgeReject(input);
        if (a === "pending") return { edges: await h.edgesPending(input) };
        return { edges: await h.recallByEdge(input) };
      },
    },
    {
      name: "procedure",
      description:
        "Prose runbooks that proved to work. action='grounding' (trigger, action_type) — call when STARTING an action: 'follow-this' results are validated, 'draft-verify' are unproven. action='propose' (name, trigger, steps, depends_on_paths, sources) — after a VERIFIED multi-step success worth repeating. action='outcome' (procedure_id, outcome, judge_confirmed, situation, action_type, evidence) — after applying one. action='sweep' — mark runbooks stale whose depends_on_paths changed.",
      inputSchema: { type: "object", required: ["action"], properties: {
        action: { type: "string", enum: ["grounding", "propose", "outcome", "sweep"] },
        trigger: { type: "string" }, action_type: { type: "string", enum: ACTION_TYPE_ENUM }, k: { type: "number" },
        name: { type: "string" }, steps: { type: "array", items: { type: "string" } },
        depends_on_paths: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } },
        procedure_id: { type: "string" }, outcome: { type: "string", enum: OUTCOME_ENUM }, judge_confirmed: { type: "boolean" },
        situation: { type: "string" }, evidence: { type: "string" }, cycle_id: { type: "string" }, epic_id: { type: ["string", "null"] },
      } },
      handler: async (input: any) => {
        const a = requireAction(input, ["grounding", "propose", "outcome", "sweep"] as const);
        if (a === "grounding") return h.procedureGrounding(input);
        if (a === "propose") return h.procedurePropose(input);
        if (a === "outcome") return h.procedureOutcome(input);
        return h.procedureSweep(input);
      },
    },
    {
      name: "task_state",
      description:
        "Durable plan state for long-running work (one row per epic, rewritten not appended, pinned while active). action='read' (epic_id?) — call when resuming; no epic_id lists active epics. action='write' — rewrite the plan at every significant state change: epic_id, title, status, plan[{step,status,note?}], open_threads, touched[{path,sha}], blockers.",
      inputSchema: { type: "object", required: ["action"], properties: {
        action: { type: "string", enum: ["read", "write"] },
        epic_id: { type: "string" }, title: { type: "string" },
        status: { type: "string", enum: ["active", "completed"] },
        plan: { type: "array", items: { type: "object", properties: { step: { type: "string" }, status: { type: "string", enum: ["done", "active", "todo"] }, note: { type: "string" } } } },
        open_threads: { type: "array", items: { type: "string" } },
        touched: { type: "array", items: { type: "object", properties: { path: { type: "string" }, sha: { type: "string" } } } },
        blockers: { type: "array", items: { type: "string" } },
      } },
      handler: async (input: any) => {
        const a = requireAction(input, ["read", "write"] as const);
        return a === "read" ? h.taskStateRead(input) : h.taskStateWrite(input);
      },
    },
    {
      name: "memory_maintain",
      description:
        "Hygiene, not for every call. action='decay_sweep' — apply weight decay, archive faded STM, prune weak edges (periodic). action='pattern_check' (domains) — count failure_signatures/retries per domain to spot repeated failure patterns before retrying an approach.",
      inputSchema: { type: "object", required: ["action"], properties: {
        action: { type: "string", enum: ["decay_sweep", "pattern_check"] },
        domains: { type: "array", items: { type: "string" } },
      } },
      handler: async (input: any) => {
        const a = requireAction(input, ["decay_sweep", "pattern_check"] as const);
        return a === "decay_sweep" ? h.decaySweep() : h.patternCheck(input);
      },
    },
  ];

  // ---- legacy: the pre-consolidation names, unchanged, dispatching to the same handlers ----
  const legacy: MemoryTool[] = [
    { name: "memory_write_stm", description: "Write a short-term memory entry. Use for observations, hypotheses, anomalies, retries. (Legacy: prefer memory_write with tier='stm'.)",
      inputSchema: { type: "object", required: ["type", "content", "sources"], properties: { type: { type: "string" }, content: { type: "string" }, sources: { type: "array", items: { type: "string" } } } },
      handler: h.writeStm },
    { name: "memory_write_ltm", description: "Write a long-term memory entry. Use only for verified, durable knowledge — after a decision or confirmed outcome, with a stated reason. (Legacy: prefer memory_write with tier='ltm'.)",
      inputSchema: { type: "object", required: ["type", "content", "sources", "reason"], properties: { type: { type: "string" }, content: { type: "string" }, sources: { type: "array", items: { type: "string" } }, reason: { type: "string" } } },
      handler: h.writeLtm },
    { name: "memory_recall_with_edges", description: "Recall plus walk approved edges to depth N. (Legacy: prefer memory_recall with with_edges=true.)",
      inputSchema: { type: "object", required: ["cue"], properties: { cue: { type: "string" }, k: { type: "number" }, edge_depth: { type: "number" }, tier: { type: "string" }, types: { type: "array", items: { type: "string" } } } },
      handler: h.recallWithEdges },
    { name: "memory_recall_by_id", description: "Fetch a single memory entry by id. (Legacy: prefer memory_recall with id.)",
      inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      handler: h.recallById },
    { name: "memory_recall_by_edge", description: "List approved edges matching from/to/type filters. (Legacy: prefer memory_graph action='list'.)",
      inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, type: { type: "string" } } },
      handler: h.recallByEdge },
    { name: "memory_pattern_check", description: "For given domains, count failure_signatures and retries; return top signatures and dominant type. (Legacy: prefer memory_maintain action='pattern_check'.)",
      inputSchema: { type: "object", required: ["domains"], properties: { domains: { type: "array", items: { type: "string" } } } },
      handler: h.patternCheck },
    { name: "memory_revise_ltm", description: "Rewrite an LTM entry with audit trail. (Legacy: prefer memory_edit action='revise'.)",
      inputSchema: { type: "object", required: ["id", "new_content", "reason"], properties: { id: { type: "string" }, new_content: { type: "string" }, reason: { type: "string" }, dream_source_id: { type: ["string", "null"] } } },
      handler: h.reviseLtm },
    { name: "memory_promote", description: "Convert STM → LTM. (Legacy: prefer memory_edit action='promote'.)",
      inputSchema: { type: "object", required: ["stm_id", "reason"], properties: { stm_id: { type: "string" }, reason: { type: "string" } } },
      handler: h.promote },
    { name: "memory_demote", description: "Convert LTM → STM for revalidation. (Legacy: prefer memory_edit action='demote'.)",
      inputSchema: { type: "object", required: ["ltm_id", "reason"], properties: { ltm_id: { type: "string" }, reason: { type: "string" } } },
      handler: h.demote },
    { name: "memory_decay_sweep", description: "Apply tier-specific weight decay; archive STM below 0.1; decay + prune edges. (Legacy: prefer memory_maintain action='decay_sweep'.)",
      inputSchema: { type: "object", properties: {} },
      handler: h.decaySweep },
    { name: "memory_bump_verdict_boost", description: "Increment a memory's verdict_boost by 1. (Legacy: memory_reinforce with reason 'act-cite' does this too.)",
      inputSchema: { type: "object", required: ["id", "reason"], properties: { id: { type: "string" }, reason: { type: "string", description: "'act-cite' | 'dream-cite'" }, cycleId: { type: "string" } } },
      handler: h.bumpVerdictBoost },
    { name: "memory_edge_propose", description: "Propose a graph edge between two memory entries. (Legacy: prefer memory_graph action='propose'.)",
      inputSchema: { type: "object", required: ["from", "to", "type", "reason"], properties: { from: { type: "string" }, to: { type: "string" }, type: { type: "string" }, reason: { type: "string" }, dream_source_id: { type: ["string", "null"] } } },
      handler: h.edgePropose },
    { name: "memory_edge_approve", description: "Approve a proposed edge (curator step). (Legacy: prefer memory_graph action='approve'.)",
      inputSchema: { type: "object", required: ["edge_id", "approver_cycle"], properties: { edge_id: { type: "number" }, approver_cycle: { type: "string" } } },
      handler: h.edgeApprove },
    { name: "memory_edge_reject", description: "Reject a proposed edge with a reason (curator step). (Legacy: prefer memory_graph action='reject'.)",
      inputSchema: { type: "object", required: ["edge_id", "reason"], properties: { edge_id: { type: "number" }, reason: { type: "string" } } },
      handler: h.edgeReject },
    { name: "edges_pending", description: "List proposed edges awaiting curator approval. (Legacy: prefer memory_graph action='pending'.)",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      handler: h.edgesPending },
    { name: "task_state_write", description: "Write/rewrite the durable plan state for an epic. (Legacy: prefer task_state action='write'.)",
      inputSchema: { type: "object", required: ["epic_id", "title", "status", "plan", "open_threads", "touched", "blockers"], properties: {
        epic_id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["active", "completed"] },
        plan: { type: "array", items: { type: "object", properties: { step: { type: "string" }, status: { type: "string", enum: ["done", "active", "todo"] }, note: { type: "string" } } } },
        open_threads: { type: "array", items: { type: "string" } },
        touched: { type: "array", items: { type: "object", properties: { path: { type: "string" }, sha: { type: "string" } } } },
        blockers: { type: "array", items: { type: "string" } } } },
      handler: h.taskStateWrite },
    { name: "task_state_read", description: "Read an epic's durable plan state, or list active epics. (Legacy: prefer task_state action='read'.)",
      inputSchema: { type: "object", properties: { epic_id: { type: "string" } } },
      handler: h.taskStateRead },
    { name: "procedure_propose", description: "Propose a new PROCEDURE (prose runbook) after a VERIFIED success. (Legacy: prefer procedure action='propose'.)",
      inputSchema: { type: "object", required: ["name", "trigger", "steps", "depends_on_paths", "sources"], properties: { name: { type: "string" }, trigger: { type: "string" }, steps: { type: "array", items: { type: "string" } }, depends_on_paths: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } } } },
      handler: h.procedurePropose },
    { name: "procedure_outcome", description: "Record a procedure APPLICATION result. (Legacy: prefer procedure action='outcome'.)",
      inputSchema: { type: "object", required: ["procedure_id", "outcome", "judge_confirmed", "situation", "action_type", "evidence", "cycle_id"], properties: {
        procedure_id: { type: "string" }, outcome: { type: "string", enum: OUTCOME_ENUM }, judge_confirmed: { type: "boolean" }, situation: { type: "string" },
        action_type: { type: "string", enum: ACTION_TYPE_ENUM }, evidence: { type: "string" }, cycle_id: { type: "string" }, epic_id: { type: ["string", "null"] } } },
      handler: h.procedureOutcome },
    { name: "procedure_sweep", description: "Staleness sweep over validated procedures' depends_on_paths. (Legacy: prefer procedure action='sweep'.)",
      inputSchema: { type: "object", properties: { cycleId: { type: "string" } } },
      handler: h.procedureSweep },
    { name: "procedure_grounding", description: "Retrieve procedures for the task at hand, keyed on trigger embedding + action_type. (Legacy: prefer procedure action='grounding'.)",
      inputSchema: { type: "object", required: ["trigger", "action_type"], properties: { trigger: { type: "string" }, action_type: { type: "string", enum: ACTION_TYPE_ENUM }, k: { type: "number" } } },
      handler: h.procedureGrounding },
  ];

  const tools: MemoryTool[] = toolProfile === "full" ? [...core, ...legacy] : core;

  function createMcpServer(): Server {
    const server = new Server(
      { name: "backant-memory", version },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = tools.find((t) => t.name === req.params.name);
      if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
      const result = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
    return server;
  }

  return {
    listToolNames(): string[] {
      return tools.map((t) => t.name);
    },
    listToolDescriptions(): string[] {
      return tools.map((t) => t.description);
    },
    async callTool(name: string, input: unknown): Promise<unknown> {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool.handler(input);
    },
    db,
    embedder,
    toolProfile,
    createMcpServer,
    async startStdio(): Promise<Server> {
      const server = createMcpServer();
      await server.connect(new StdioServerTransport());
      return server;
    },
  };
}

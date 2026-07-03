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

import { writeStm } from "./tools/memory/write-stm.js";
import { writeLtm } from "./tools/memory/write-ltm.js";
import { recall } from "./tools/memory/recall.js";
import { recallWithEdges } from "./tools/memory/recall-with-edges.js";
import { recallById } from "./tools/memory/recall-by-id.js";
import { recallByEdge } from "./tools/memory/recall-by-edge.js";
import { patternCheck } from "./tools/memory/pattern-check.js";
import { reviseLtm } from "./tools/memory/revise-ltm.js";
import { reinforce } from "./tools/memory/reinforce.js";
import { promote } from "./tools/memory/promote.js";
import { demote } from "./tools/memory/demote.js";
import { decaySweep } from "./tools/memory/decay-sweep.js";
import { taskStateWrite } from "./tools/memory/task-state-write.js";
import { taskStateRead } from "./tools/memory/task-state-read.js";
import { writeEpisode } from "./tools/memory/write-episode.js";
import { procedurePropose } from "./tools/memory/procedure-propose.js";
import { procedureOutcome } from "./tools/memory/procedure-outcome.js";
import { bumpVerdictBoost } from "./tools/memory/bump-verdict-boost.js";

import { edgePropose } from "./tools/edges/propose.js";
import { edgeApprove } from "./tools/edges/approve.js";
import { edgeReject } from "./tools/edges/reject.js";
import { edgesPending } from "./tools/edges/pending.js";

import { procedureSweep } from "./tools/procedures/procedure-sweep.js";
import { procedureGrounding } from "./tools/procedures/procedure-grounding.js";
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

interface BuildOptions {
  workspaceCwd: string;
  memoryDbPath?: string;
  ollamaUrl?: string;
  embeddingModel?: string;
  /** Repo key (owner/repo) this server's memory is scoped to. */
  repo?: string;
  /** Pre-opened memory db (used by buildMemoryContext in boot wiring). */
  db?: MemoryDb;
}

export interface MemoryServer {
  listToolNames(): string[];
  listToolDescriptions(): string[];
  callTool(name: string, input: unknown): Promise<unknown>;
  db: MemoryDb;
  embedder: Embedder;
  createMcpServer(): Server;
  startStdio(): Promise<Server>;
}

export async function buildMemoryServer(opts: BuildOptions): Promise<MemoryServer> {
  const { workspaceCwd } = opts;
  const memoryDbPath = opts.memoryDbPath
    ?? join(homedir(), ".claude/kairos/memory/.index.db");
  const ollamaUrl = opts.ollamaUrl ?? "http://127.0.0.1:11434";
  const embeddingModel = opts.embeddingModel ?? "qwen3-embedding:0.6b";

  const db: MemoryDb = opts.db ?? (await openMemoryDb({ localPath: memoryDbPath, repo: opts.repo ?? "" }));
  const client = new OllamaClient({ baseUrl: ollamaUrl });
  const embedder = new Embedder({ client, model: embeddingModel });

  const tools: MemoryTool[] = [];

  tools.push({
    name: "memory_write_stm",
    description: "Write a short-term memory entry. Use for observations, hypotheses, anomalies, retries.",
    inputSchema: { type: "object", required: ["type", "content", "sources"], properties: { type: { type: "string" }, content: { type: "string" }, sources: { type: "array", items: { type: "string" } } } },
    handler: async (input: any) => writeStm({ db, embedder, input }),
  });
  tools.push({
    name: "memory_write_ltm",
    description: "Write a long-term memory entry. Use only for verified, durable knowledge — after a decision or confirmed outcome, with a stated reason.",
    inputSchema: { type: "object", required: ["type", "content", "sources", "reason"], properties: { type: { type: "string" }, content: { type: "string" }, sources: { type: "array", items: { type: "string" } }, reason: { type: "string" } } },
    handler: async (input: any) => writeLtm({ db, embedder, input }),
  });
  tools.push({
    name: "memory_recall",
    description: "Cue-based hybrid retrieval (BM25 + cosine + weight + recency). USE BEFORE any decision touching a previously-discussed topic. The agent that doesn't recall is hallucinating its history.",
    inputSchema: { type: "object", required: ["cue"], properties: { cue: { type: "string" }, k: { type: "number" }, tier: { type: "string" }, types: { type: "array", items: { type: "string" } }, with_edges: { type: "boolean" } } },
    handler: async (input: any) => recall({ db, embedder, input }),
  });
  tools.push({
    name: "memory_recall_with_edges",
    description: "Recall plus walk approved edges to depth N. Use for grounding decisions where relationships matter.",
    inputSchema: { type: "object", required: ["cue"], properties: { cue: { type: "string" }, k: { type: "number" }, edge_depth: { type: "number" }, tier: { type: "string" }, types: { type: "array", items: { type: "string" } } } },
    handler: async (input: any) => recallWithEdges({ db, embedder, input }),
  });
  tools.push({
    name: "memory_recall_by_id",
    description: "Fetch a single memory entry by id.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    handler: async (input: any) => recallById({ db, id: input.id }),
  });
  tools.push({
    name: "memory_recall_by_edge",
    description: "List approved edges matching from/to/type filters.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, type: { type: "string" } } },
    handler: async (input: any) => recallByEdge({ db, input }),
  });
  tools.push({
    name: "memory_pattern_check",
    description: "For given domains, count failure_signatures and retries; return top signatures and dominant type. Use to detect repeated failure patterns.",
    inputSchema: { type: "object", required: ["domains"], properties: { domains: { type: "array", items: { type: "string" } } } },
    handler: async (input: any) => patternCheck({ db, input }),
  });
  tools.push({
    name: "memory_revise_ltm",
    description: "Rewrite an LTM entry with audit trail. Increment version; old content lands in ltm_history.",
    inputSchema: { type: "object", required: ["id", "new_content", "reason"], properties: { id: { type: "string" }, new_content: { type: "string" }, reason: { type: "string" }, dream_source_id: { type: ["string", "null"] } } },
    handler: async (input: any) => reviseLtm({ db, embedder, ...input }),
  });
  tools.push({
    name: "memory_reinforce",
    description: "Multiply an entry's weight by factor (clamped to [0,1]). Reason 'dream-cite' / 'act-cite' increment counters.",
    inputSchema: { type: "object", required: ["id", "factor", "reason"], properties: { id: { type: "string" }, factor: { type: "number" }, reason: { type: "string" } } },
    handler: async (input: any) => reinforce({ db, ...input }),
  });
  tools.push({
    name: "memory_promote",
    description: "Convert STM → LTM (sequenced id under type). Use when STM evidence accumulates.",
    inputSchema: { type: "object", required: ["stm_id", "reason"], properties: { stm_id: { type: "string" }, reason: { type: "string" } } },
    handler: async (input: any) => promote({ db, ...input }),
  });
  tools.push({
    name: "memory_demote",
    description: "Convert LTM → STM for revalidation. Use when an LTM entry is contradicted with low recent citations.",
    inputSchema: { type: "object", required: ["ltm_id", "reason"], properties: { ltm_id: { type: "string" }, reason: { type: "string" } } },
    handler: async (input: any) => demote({ db, ...input }),
  });
  tools.push({
    name: "memory_decay_sweep",
    description: "Apply tier-specific weight decay across all entries; archive STM below 0.1; decay + prune edges. Run periodically (hygiene), not on every call.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => decaySweep({ db }),
  });
  tools.push({
    name: "task_state_write",
    description: "Write/rewrite the durable plan state for a long-running task or epic (one row per epic; rewritten not appended). Pin weight while active; release on completion.",
    inputSchema: { type: "object", required: ["epic_id", "title", "status", "plan", "open_threads", "touched", "blockers"], properties: {
      epic_id: { type: "string" }, title: { type: "string" },
      status: { type: "string", enum: ["active", "completed"] },
      plan: { type: "array", items: { type: "object", properties: { step: { type: "string" }, status: { type: "string", enum: ["done", "active", "todo"] }, note: { type: "string" } } } },
      open_threads: { type: "array", items: { type: "string" } },
      touched: { type: "array", items: { type: "object", properties: { path: { type: "string" }, sha: { type: "string" } } } },
      blockers: { type: "array", items: { type: "string" } },
    } },
    handler: async (input: any) => taskStateWrite({ db, embedder, input }),
  });
  tools.push({
    name: "task_state_read",
    description: "Read an epic's durable plan state by epic_id, or list all active epics when epic_id is omitted. Call when resuming work.",
    inputSchema: { type: "object", properties: { epic_id: { type: "string" } } },
    handler: async (input: any) => taskStateRead({ db, input }),
  });
  tools.push({
    name: "memory_write_episode",
    description: "Record a trajectory episode at a decision point (attempt, retry, override). Weight is surprise-scaled deterministically from expected vs outcome. Call after each meaningful action.",
    inputSchema: { type: "object", required: ["situation", "action_type", "action_taken", "expected", "outcome", "evidence", "epic_id", "cycle_id"], properties: {
      situation: { type: "string" },
      action_type: { type: "string", enum: ["fix", "merge", "implement", "review-feedback", "migrate", "investigate", "other"] },
      action_taken: { type: "string" },
      expected: { type: "string", enum: ["success", "failure"] },
      outcome: { type: "string", enum: ["success", "failure", "partial"] },
      evidence: { type: "string" },
      epic_id: { type: "string" }, cycle_id: { type: "string" },
      source: { type: "string" },
    } },
    handler: async (input: any) => writeEpisode({ db, embedder, source: input.source, input }),
  });
  tools.push({
    name: "memory_edge_propose",
    description: "Propose a graph edge between two memory entries. Status=proposed until a curator review approves/rejects it.",
    inputSchema: { type: "object", required: ["from", "to", "type", "reason"], properties: {
      from: { type: "string" }, to: { type: "string" },
      type: { type: "string" }, reason: { type: "string" },
      dream_source_id: { type: ["string", "null"] },
    } },
    handler: async (input: any) => edgePropose({ db, input }),
  });
  tools.push({
    name: "memory_edge_approve",
    description: "Approve a proposed edge after reviewing its evidence (curator step).",
    inputSchema: { type: "object", required: ["edge_id", "approver_cycle"], properties: {
      edge_id: { type: "number" }, approver_cycle: { type: "string" },
    } },
    handler: async (input: any) => edgeApprove({ db, ...input }),
  });
  tools.push({
    name: "memory_edge_reject",
    description: "Reject a proposed edge with a reason (curator step).",
    inputSchema: { type: "object", required: ["edge_id", "reason"], properties: {
      edge_id: { type: "number" }, reason: { type: "string" },
    } },
    handler: async (input: any) => edgeReject({ db, ...input }),
  });
  tools.push({
    name: "edges_pending",
    description: "List proposed edges awaiting curator approval.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    handler: async (input: any) => edgesPending({ db, input }),
  });
  tools.push({
    name: "procedure_propose",
    description: "Propose a new PROCEDURE (prose runbook) after a VERIFIED success. Lands as 'proposed'. depends_on_paths must list every file whose change should invalidate the procedure; validated_at_sha is computed server-side from those paths' current SHAs.",
    inputSchema: { type: "object", required: ["name", "trigger", "steps", "depends_on_paths", "sources"], properties: {
      name: { type: "string" }, trigger: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
      depends_on_paths: { type: "array", items: { type: "string" } },
      sources: { type: "array", items: { type: "string" } },
    } },
    handler: async (input: any) => procedurePropose({ db, embedder, cwd: workspaceCwd, input }),
  });
  tools.push({
    name: "procedure_outcome",
    description: "Record a procedure APPLICATION result. Server-side: promotes proposed/stale->validated at N=2 confirmed successes; on failure fires failure_signature and decrements success_rate (archives below 0.5 after >=4 applications); always writes an episode (cycle_id required).",
    inputSchema: { type: "object", required: ["procedure_id", "outcome", "judge_confirmed", "situation", "action_type", "evidence", "cycle_id"], properties: {
      procedure_id: { type: "string" },
      outcome: { type: "string", enum: ["success", "failure", "partial"] },
      judge_confirmed: { type: "boolean" },
      situation: { type: "string" },
      action_type: { type: "string", enum: ["fix", "merge", "implement", "review-feedback", "migrate", "investigate", "other"] },
      evidence: { type: "string" },
      cycle_id: { type: "string" },
      epic_id: { type: ["string", "null"] },
    } },
    handler: async (input: any) => procedureOutcome({ db, embedder, input }),
  });
  tools.push({
    name: "procedure_sweep",
    description: "Staleness sweep: diff each validated procedure's depends_on_paths against current git tree SHAs; drift -> status='stale'. Run at session/cycle start. Returns {scanned, marked_stale}.",
    inputSchema: { type: "object", properties: { cycleId: { type: "string" } } },
    handler: async (input: any) => procedureSweep({ db, cwd: workspaceCwd, cycleId: input?.cycleId ?? UNTRACKED_CYCLE_ID }),
  });
  tools.push({
    name: "procedure_grounding",
    description: "Retrieve procedures for the task at hand, keyed on trigger embedding + action_type. Validated procedures inject as 'follow-this'; proposed/stale as 'draft-verify'; archived excluded. Call when starting an action.",
    inputSchema: { type: "object", required: ["trigger", "action_type"], properties: {
      trigger: { type: "string" },
      action_type: { type: "string", enum: ["fix", "merge", "implement", "review-feedback", "migrate", "investigate", "other"] },
      k: { type: "number" },
    } },
    handler: async (input: any) => procedureGrounding({ db, embedder, input }),
  });
  tools.push({
    name: "memory_bump_verdict_boost",
    description: "Increment a memory's verdict_boost by 1 (additive ranking signal). Call when the memory proved useful in practice. Advances change_seq so recall_cache invalidates.",
    inputSchema: { type: "object", required: ["id", "reason"], properties: {
      id: { type: "string" },
      reason: { type: "string", description: "'act-cite' | 'dream-cite'" },
      cycleId: { type: "string" },
    } },
    handler: async (input: any) => bumpVerdictBoost({
      db, id: input.id, reason: input.reason, cycleId: input?.cycleId,
    }),
  });

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
    createMcpServer,
    async startStdio(): Promise<Server> {
      const server = createMcpServer();
      await server.connect(new StdioServerTransport());
      return server;
    },
  };
}

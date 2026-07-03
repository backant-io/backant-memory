import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import type { ActionType } from "../../memory/episodic-types.js";
import { recall } from "../memory/recall.js";
import { parseProcedure } from "../../memory/procedure-content.js";

export type ProcedureInjection = "follow-this" | "draft-verify";

export interface GroundedProcedure {
  id: string;
  name: string;
  trigger: string;
  steps: string[];
  status: "proposed" | "validated" | "stale";
  injection: ProcedureInjection;
  score: number;
}

export interface ProcedureGroundingInput {
  /** The chosen action's trigger phrase; embedded for retrieval (spec §3.3). */
  trigger: string;
  /** The chosen action type (closed set from spec §1.2) — scopes co-fetched episodes. */
  action_type: ActionType;
  k?: number;
}

export interface ProcedureGroundingResult {
  trigger: string;
  action_type: ActionType;
  procedures: GroundedProcedure[];
}

export async function procedureGrounding(deps: {
  db: MemoryDb;
  embedder: Embedder;
  repo?: string;
  cycleId?: string;
  input: ProcedureGroundingInput;
}): Promise<ProcedureGroundingResult> {
  const k = deps.input.k ?? 5;

  const hits = await recall({
    db: deps.db, embedder: deps.embedder, repo: deps.repo, cycleId: deps.cycleId, caller: "act",
    input: { cue: deps.input.trigger, k: k * 4, tier: "ltm", types: ["procedure"] },
  });

  const procedures: GroundedProcedure[] = [];
  for (const h of hits) {
    let c;
    try { c = parseProcedure(h.content); } catch { continue; }
    if (c.status === "archived") continue; // never inject archived (spec §3.2)
    const injection: ProcedureInjection = c.status === "validated" ? "follow-this" : "draft-verify";
    procedures.push({
      id: h.id, name: c.name, trigger: c.trigger, steps: c.steps,
      status: c.status, injection, score: h.score,
    });
    if (procedures.length >= k) break;
  }

  return { trigger: deps.input.trigger, action_type: deps.input.action_type, procedures };
}

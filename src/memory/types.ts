export type MemoryTier = "stm" | "ltm";

export type MemoryType =
  | "observation"
  | "hypothesis"
  | "anomaly"
  | "retry"
  | "market"
  | "candidate-survivor"
  | "failure_signature"
  | "architecture"
  | "lesson"
  | "principle"
  | "priority"
  | "product-fact"
  | "epic_outcome"
  | "procedure"
  /** Deterministic per-session digest written by the PreCompact/SessionEnd hook. */
  | "session_summary";

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  type: MemoryType;
  content: string;
  sources: string[];
  weight: number;
  created: string;
  last_reinforced: string;
  dream_citations: number;
  act_citations: number;
  revision_count: number;
  embedding: Float32Array | null;
}

export type EdgeType =
  | "related_to"
  | "contradicts"
  | "supports"
  | "supersedes"
  | "refines";

export type EdgeStatus = "proposed" | "approved" | "rejected";

export interface Edge {
  id: number;
  from_id: string;
  to_id: string;
  edge_type: EdgeType;
  weight: number;
  status: EdgeStatus;
  reason: string | null;
  dream_source_id: string | null;
  created: string;
  approved_cycle: string | null;
  last_used: string | null;
}

export type CandidateVerdict = "ACT" | "KEEP" | "DISCARD" | "REVISE";

export interface DreamCandidate {
  id: string;
  hypothesis: string;
  sources: string[];
  score: number;
  score_breakdown: Record<string, number>;
  generator: "co_activation" | "reflective" | "meta";
  strategy_level: "flat" | "strategy" | "step";
  parent_id: string | null;
  child_ids: string[] | null;
  tier_target: string | null;
  ttl: number;
  created: string;
  verdict: CandidateVerdict | null;
  verdict_cycle: string | null;
  verdict_reason: string | null;
}

export interface LtmHistory {
  id: number;
  ltm_id: string;
  version: number;
  old_content: string;
  new_content: string;
  dream_source_id: string | null;
  judge_decision_cycle: string | null;
  reason: string;
  timestamp: string;
}

export interface FailureSignature {
  symptom: string;
  attempted_fix: string;
  constraint_violated: string;
  missing_signal: string;
}

/** Procedure lifecycle states (spec §3.2). `stale` retrieves/promotes like `proposed`;
 *  it is kept distinct only so the audit trail shows the row was once validated and drifted. */
export type ProcedureStatus = "proposed" | "validated" | "stale" | "archived";

/** JSON payload stored in the `content` column of a `type='procedure'` memory row (spec §3.1).
 *  Prose-only — `steps` are human/agent-readable strings with `{placeholder}` parameters,
 *  never executables (spec §3, "Prose runbooks only; executables deferred"). */
export interface ProcedureContent {
  name: string;
  trigger: string;
  steps: string[];
  /** Repo-relative paths whose drift invalidates this procedure (content-addressed). */
  depends_on_paths: string[];
  /** Short git SHA the procedure was last validated against. */
  validated_at_sha: string;
  status: ProcedureStatus;
  times_applied: number;
  /** null until the first application is recorded. */
  success_rate: number | null;
}

/** A full procedure memory row (the `content` column parsed). */
export interface Procedure extends ProcedureContent {
  id: string;
}

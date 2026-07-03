/**
 * Closed sets and JSON content shapes for the Memory v2 episodic spine
 * (spec 2026-06-11 §1.1-1.3). These ride the existing `memory.type` column
 * (no DDL); content is JSON-serialized into `memory.content`.
 */

/** action_type closed set — mirrors the kairos-act decision vocabulary (spec §1.2). */
export const ACTION_TYPES = [
  "fix",
  "merge",
  "implement",
  "review-feedback",
  "migrate",
  "investigate",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Episode outcome closed set. */
export const EPISODE_OUTCOMES = ["success", "failure", "partial"] as const;
export type EpisodeOutcome = (typeof EPISODE_OUTCOMES)[number];

/** Expectation stated BEFORE the outcome is known — only success|failure. */
export type EpisodeExpected = "success" | "failure";

export type TaskStateStatus = "active" | "completed";

export interface TaskStatePlanStep {
  step: string;
  status: "done" | "active" | "todo";
  note?: string;
}

export interface TaskStateTouched {
  path: string;
  sha: string;
}

/** Content shape for a `task_state` row (spec §1.1). */
export interface TaskStateContent {
  epic_id: string;
  title: string;
  status: TaskStateStatus;
  plan: TaskStatePlanStep[];
  open_threads: string[];
  touched: TaskStateTouched[];
  blockers: string[];
}

/** Content shape for an `episode` row (spec §1.2). */
export interface EpisodeContent {
  situation: string;
  action_type: ActionType;
  action_taken: string;
  expected: EpisodeExpected;
  outcome: EpisodeOutcome;
  evidence: string;
  epic_id: string;
  cycle_id: string;
}

/** Content shape for the `handoff_brief` row (spec §1.3). */
export interface HandoffBriefContent {
  active_epic: string;
  last_completed_step: string;
  next_action: string;
  working_set: TaskStateTouched[];
  blockers: string[];
  do_not_redo: string[];
}

/**
 * Deterministic surprise multiplier (spec §1.2): 1.0 when the realized outcome
 * matches the pre-stated expectation, 2.0 when it does not. Fixed range {1.0, 2.0}
 * in v2 — NO LLM self-assessment. 'partial' never equals an expectation, so it
 * always counts as surprising.
 */
export function surpriseMultiplier(
  expected: EpisodeExpected,
  outcome: EpisodeOutcome
): number {
  return expected === (outcome as EpisodeExpected) ? 1.0 : 2.0;
}

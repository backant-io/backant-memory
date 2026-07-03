/**
 * Derive recall cues from live task state, AUGMENTING the fixed STARTUP_CUES.
 *
 * C0 decision (Memory v2 Plan 2, Part C): PROCEED-ADDITIVE. The dynamic
 * live-state cues produced here run *in addition to* the 5 fixed STARTUP_CUES,
 * they do NOT replace them — trace evidence is still thin, so we keep the fixed
 * safety net and let richer traces justify full replacement later.
 *
 * Pure: code answers (Rule 5), no LLM, no DB. The caller passes the parsed
 * task_state row (Layer 1 §1.1) and the current board candidates.
 */
export interface TaskStateForCues {
  title: string;
  plan: { step: string; status: string }[];
  touched: { path: string; sha?: string }[];
}

export interface DeriveCuesInput {
  taskState: TaskStateForCues | null;
  boardCandidates: string[];
}

const MAX_CUES = 8;

export function deriveDecisionCues(input: DeriveCuesInput): string[] {
  const raw: string[] = [];

  if (input.taskState) {
    raw.push(input.taskState.title);
    const active = input.taskState.plan.find((p) => p.status === "active");
    if (active) raw.push(active.step);
    for (const t of input.taskState.touched) {
      const base = t.path.split("/").pop() ?? t.path;
      raw.push(base);
    }
  }

  for (const c of input.boardCandidates) raw.push(c);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw) {
    const trimmed = c.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_CUES) break;
  }
  return out;
}

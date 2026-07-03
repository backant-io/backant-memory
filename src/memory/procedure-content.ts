import type { ProcedureContent, ProcedureStatus } from "./types.js";

/** proposed/stale → validated after this many judge-confirmed successes (spec §3.2). */
export const PROMOTION_THRESHOLD = 2;

/** success_rate at or below this floor archives the procedure (spec §3.2). */
export const ARCHIVE_FLOOR = 0.5;

/** ...but only once it has been applied at least this many times (spec §3.2). */
export const ARCHIVE_MIN_APPLICATIONS = 4;

export function serializeProcedure(c: ProcedureContent): string {
  return JSON.stringify(c);
}

export function parseProcedure(json: string): ProcedureContent {
  const c = JSON.parse(json) as ProcedureContent;
  if (typeof c.name !== "string" || !Array.isArray(c.steps)) {
    throw new Error("malformed procedure content");
  }
  return c;
}

/** Embedding is computed over name + trigger only (spec §3.1, "Embedding computed over name + trigger"). */
export function embeddingTextFor(c: Pick<ProcedureContent, "name" | "trigger">): string {
  return `${c.name}\n${c.trigger}`;
}

/** Recompute the running success_rate from the prior rate and prior count. */
function nextRate(prior: ProcedureContent, didSucceed: boolean): number {
  const priorSuccesses = prior.success_rate === null
    ? 0
    : Math.round(prior.success_rate * prior.times_applied);
  const successes = priorSuccesses + (didSucceed ? 1 : 0);
  const total = prior.times_applied + 1;
  return successes / total;
}

export function applySuccess(c: ProcedureContent): ProcedureContent {
  return { ...c, times_applied: c.times_applied + 1, success_rate: nextRate(c, true) };
}

export function applyFailure(c: ProcedureContent): ProcedureContent {
  return { ...c, times_applied: c.times_applied + 1, success_rate: nextRate(c, false) };
}

/** Promotion gate: `proposed` and `stale` promote to `validated`; nothing else does.
 *  `successesSinceProposed` is tracked by the caller (judge-confirmed successes since the
 *  current proposed/stale spell began). */
export function shouldPromote(status: ProcedureStatus, successesSinceProposed: number): boolean {
  if (status !== "proposed" && status !== "stale") return false;
  return successesSinceProposed >= PROMOTION_THRESHOLD;
}

/** Archive when the running success_rate has dropped below the floor, but only
 *  after enough applications that the rate is meaningful (spec §3.2). At the floor
 *  (0.5) is acceptable; only strictly below it archives (spec architecture: "success_rate < 0.5"). */
export function shouldArchive(c: ProcedureContent): boolean {
  if (c.success_rate === null) return false;
  return c.times_applied >= ARCHIVE_MIN_APPLICATIONS && c.success_rate < ARCHIVE_FLOOR;
}

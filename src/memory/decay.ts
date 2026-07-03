import type { MemoryTier } from "./types.js";

export function decayFactorForTier(tier: MemoryTier): number {
  return tier === "stm" ? 0.7 : 0.98;
}

export function shouldArchive(tier: MemoryTier, weight: number): boolean {
  if (tier === "ltm") return false;
  return weight < STM_ARCHIVE_CUTOFF;
}

export function decayEdgeFactor(opts: { totalEdges: number }): number {
  return opts.totalEdges > 10_000 ? 0.85 : 0.95;
}

export const STM_ARCHIVE_CUTOFF = 0.1;
export const EDGE_ARCHIVE_CUTOFF_NORMAL = 0.1;
export const EDGE_ARCHIVE_CUTOFF_LARGE = 0.15;
export const DEMOTE_WEIGHT_CAP = 0.5;

import type { MemoryDb } from "../../memory/libsql-db.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";

export interface BumpVerdictBoostDeps {
  db: MemoryDb;
  id: string;
  /** "act-cite" | "dream-cite" — audit reason only; both increment by 1. */
  reason: string;
  cycleId?: string;
  now?: () => Date;
}

export async function bumpVerdictBoost(deps: BumpVerdictBoostDeps): Promise<{
  id: string;
  new_verdict_boost: number;
}> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;

  const current = await deps.db.get<{ verdict_boost: number }>(
    "SELECT verdict_boost FROM memory WHERE id = ?",
    [deps.id]
  );
  if (!current) throw new Error(`memory entry not found: ${deps.id}`);

  const next = Number(current.verdict_boost) + 1;

  await deps.db.batch([
    {
      // Normal UPDATE memory — fires bump_seq_on_memory_update, so recall_cache invalidates.
      sql: "UPDATE memory SET verdict_boost = ? WHERE id = ?",
      args: [next, deps.id],
    },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
            VALUES (?, 'bump_verdict_boost', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ id: deps.id, reason: deps.reason }),
        JSON.stringify({ new_verdict_boost: next }),
        now,
      ],
    },
  ]);

  return { id: deps.id, new_verdict_boost: next };
}

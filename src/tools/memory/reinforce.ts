import type { MemoryDb } from "../../memory/libsql-db.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";

export interface ReinforceDeps {
  db: MemoryDb;
  id: string;
  factor: number;
  reason: string;
  cycleId?: string;
  now?: () => Date;
}

export async function reinforce(deps: ReinforceDeps): Promise<{
  id: string;
  new_weight: number;
}> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;

  const current = await deps.db.get<{ weight: number }>(
    "SELECT weight FROM memory WHERE id = ?",
    [deps.id]
  );
  if (!current) throw new Error(`memory entry not found: ${deps.id}`);

  const newWeight = Math.min(1.0, Math.max(0.0, current.weight * deps.factor));

  // A citation (act-cite | dream-cite) is the "memory was confirmed useful"
  // signal, so it also raises verdict_boost — the additive ranking term recall
  // fusion weights at W_VERDICT. Folded into the SAME UPDATE as the citation
  // counter so it is one normal `UPDATE memory` that fires bump_seq_on_memory_update
  // (recall_cache stays correct). Storage is uncapped (matches bumpVerdictBoost:
  // verdict_boost + 1); the single ranking cap lives in recall.ts as
  // min(verdict_boost, VERDICT_BOOST_CAP)/VERDICT_BOOST_CAP — not duplicated here.
  // Non-citation reasons (e.g. decay) must NOT bump verdict_boost.
  let updateSql: string;
  if (deps.reason === "dream-cite") {
    updateSql =
      "UPDATE memory SET weight = ?, last_reinforced = ?, dream_citations = dream_citations + 1, verdict_boost = verdict_boost + 1 WHERE id = ?";
  } else if (deps.reason === "act-cite") {
    updateSql =
      "UPDATE memory SET weight = ?, last_reinforced = ?, act_citations = act_citations + 1, verdict_boost = verdict_boost + 1 WHERE id = ?";
  } else {
    updateSql = "UPDATE memory SET weight = ?, last_reinforced = ? WHERE id = ?";
  }

  await deps.db.batch([
    { sql: updateSql, args: [newWeight, now, deps.id] },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
            VALUES (?, 'reinforce', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ id: deps.id, factor: deps.factor, reason: deps.reason }),
        JSON.stringify({ new_weight: newWeight }),
        now,
      ],
    },
  ]);

  return { id: deps.id, new_weight: newWeight };
}

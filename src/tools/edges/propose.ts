import type { MemoryDb } from "../../memory/libsql-db.js";
import type { EdgeType } from "../../memory/types.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";

export interface EdgeProposeInput {
  from: string;
  to: string;
  type: EdgeType;
  reason: string;
  dream_source_id: string | null;
}

// Note: edgeApprove / edgeReject deliberately don't accept cycleId yet — they're
// called by the wake-judge in Plan 3, which will plumb its own cycleId through
// at that point. Out of scope for this commit.
export async function edgePropose(deps: {
  db: MemoryDb;
  input: EdgeProposeInput;
  cycleId?: string;
  now?: () => Date;
}): Promise<{ edge_id: number }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;

  await deps.db.run(
    `INSERT INTO memory_edges (from_id, to_id, edge_type, weight, status, reason, dream_source_id, created)
     VALUES (?, ?, ?, 1.0, 'proposed', ?, ?, ?)`,
    [
      deps.input.from,
      deps.input.to,
      deps.input.type,
      deps.input.reason,
      deps.input.dream_source_id,
      now,
    ]
  );
  const idRow = await deps.db.get<{ id: number }>("SELECT last_insert_rowid() AS id");
  const edgeId = Number(idRow?.id ?? 0);

  await deps.db.run(
    `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
     VALUES (?, 'edge_propose', ?, ?, ?)`,
    [
      cycleId,
      JSON.stringify({
        from: deps.input.from,
        to: deps.input.to,
        edge_type: deps.input.type,
        reason: deps.input.reason,
      }),
      JSON.stringify({ edge_id: edgeId }),
      now,
    ]
  );

  return { edge_id: edgeId };
}

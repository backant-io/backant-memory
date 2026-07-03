import type { MemoryDb } from "../../memory/libsql-db.js";

export async function edgeReject(deps: {
  db: MemoryDb;
  edge_id: number;
  reason: string;
}): Promise<{ ok: true }> {
  await deps.db.run(
    `UPDATE memory_edges SET status='rejected', reason = COALESCE(reason, '') || ' [rejected: ' || ? || ']' WHERE id = ?`,
    [deps.reason, deps.edge_id]
  );
  return { ok: true };
}

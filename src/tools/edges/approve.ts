import type { MemoryDb } from "../../memory/libsql-db.js";

/**
 * Approve a proposed edge. For a `supersedes` edge this ALSO invalidates the
 * superseded belief bi-temporally (spec §4.2): set `valid_to` on the `to_id`
 * row AND delete it from `memory_fts` (FTS is maintained by code, not triggers,
 * and no other edge tool touches it). Without the FTS delete a superseded
 * belief keeps surfacing through BM25 even after the vector path filters it
 * (recall now also excludes `valid_to IS NOT NULL` rows — see recall.ts).
 * The `UPDATE memory ... SET valid_to` advances `change_seq` (existing trigger),
 * so `recall_cache` invalidates correctly (locked decision #11).
 *
 * Direction guard (against silent data loss): the convention is from=new belief,
 * to=old belief, so we invalidate `to_id`. The supersedes edge is emitted by the
 * dream LLM (src/dream/llm.ts), where direction is *requested* but not guaranteed.
 * If the edge is reversed (`to_id` is the NEWER-created row), invalidating it
 * would destroy the fresher, correct belief — exactly what the bi-temporal model
 * exists to prevent. So we skip the invalidation when `to_id` is strictly newer
 * than `from_id`; the edge is still recorded as approved.
 */
export async function edgeApprove(deps: {
  db: MemoryDb;
  edge_id: number;
  approver_cycle: string;
  now?: () => Date;
}): Promise<{ ok: true; invalidated_id: string | null }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();

  const edge = await deps.db.get<{ edge_type: string; from_id: string; to_id: string }>(
    "SELECT edge_type, from_id, to_id FROM memory_edges WHERE id = ?",
    [deps.edge_id]
  );

  const stmts: { sql: string; args: (string | number)[] }[] = [
    {
      sql: `UPDATE memory_edges SET status='approved', approved_cycle = ?, last_used = ? WHERE id = ?`,
      args: [deps.approver_cycle, now, deps.edge_id],
    },
  ];

  let invalidatedId: string | null = null;
  if (edge && edge.edge_type === "supersedes" && (await invalidationIsSafe(deps.db, edge))) {
    // Only invalidate a row that is currently valid (idempotent re-approval).
    invalidatedId = edge.to_id;
    stmts.push({
      sql: "UPDATE memory SET valid_to = ? WHERE id = ? AND valid_to IS NULL",
      args: [now, edge.to_id],
    });
    stmts.push({
      sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)",
      args: [edge.to_id],
    });
  }

  await deps.db.batch(stmts);
  return { ok: true, invalidated_id: invalidatedId };
}

/**
 * Returns false when the supersedes edge looks reversed — i.e. `to_id` (the row
 * we'd invalidate) was created strictly later than `from_id`. In a correct
 * from=new/to=old edge, `to_id` is the older row, so invalidating it is safe.
 * If either `created` is missing we proceed (no basis to override the convention).
 */
async function invalidationIsSafe(
  db: MemoryDb,
  edge: { from_id: string; to_id: string }
): Promise<boolean> {
  const rows = await db.all<{ id: string; created: string | null }>(
    "SELECT id, created FROM memory WHERE id IN (?, ?)",
    [edge.from_id, edge.to_id]
  );
  const fromCreated = rows.find((r) => r.id === edge.from_id)?.created;
  const toCreated = rows.find((r) => r.id === edge.to_id)?.created;
  if (!fromCreated || !toCreated) return true;
  // Reversed iff the row we'd invalidate (to) is newer than the survivor (from).
  return !(toCreated > fromCreated);
}

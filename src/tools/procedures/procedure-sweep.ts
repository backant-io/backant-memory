import type { MemoryDb } from "../../memory/libsql-db.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import { parseProcedure, serializeProcedure } from "../../memory/procedure-content.js";
import { digestForPaths } from "../../memory/git-tree-sha.js";

// digestForPaths is the single source of truth for the procedure dependency digest
// (shared with procedure_propose, the write-time producer). Re-exported here so existing
// sweep consumers/tests keep importing it from this module.
export { digestForPaths };

export interface ProcedureSweepDeps {
  db: MemoryDb;
  /** Repo working directory whose git tree the dependency paths are resolved against. */
  cwd: string;
  repo?: string;
  cycleId?: string;
  now?: () => Date;
}

export interface ProcedureSweepResult {
  scanned: number;
  marked_stale: string[];
}

export async function procedureSweep(deps: ProcedureSweepDeps): Promise<ProcedureSweepResult> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;
  const repo = deps.repo ?? deps.db.repo;

  const rows = await deps.db.all<{ id: string; content: string }>(
    "SELECT id, content FROM memory WHERE repo = ? AND type = 'procedure'",
    [repo]
  );

  const markedStale: string[] = [];
  for (const row of rows) {
    let c;
    try {
      c = parseProcedure(row.content);
    } catch {
      // A single malformed procedure must not abort staleness detection for the rest.
      // Mirror procedureGrounding's defensive parse: skip the corrupt row (best-effort log).
      try {
        await deps.db.run(
          `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
           VALUES (?, 'procedure_sweep', ?, ?, ?)`,
          [cycleId, JSON.stringify({ id: row.id }), JSON.stringify({ skipped: "parse_error" }), now]
        );
      } catch { /* ops-log unavailable — nothing more to do */ }
      continue;
    }
    if (c.status !== "validated") continue; // only validated procedures are swept (spec §3.2)
    const currentDigest = digestForPaths(deps.cwd, c.depends_on_paths);
    if (currentDigest === c.validated_at_sha) continue; // no drift
    const next = serializeProcedure({ ...c, status: "stale" });
    await deps.db.batch([
      { sql: "UPDATE memory SET content = ?, last_reinforced = ? WHERE id = ?", args: [next, now, row.id] },
      { sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)", args: [row.id] },
      { sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)", args: [row.id, next] },
      {
        sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
              VALUES (?, 'procedure_sweep', ?, ?, ?)`,
        args: [cycleId, JSON.stringify({ id: row.id }), JSON.stringify({ marked: "stale" }), now],
      },
    ]);
    markedStale.push(row.id);
  }

  return { scanned: rows.length, marked_stale: markedStale };
}

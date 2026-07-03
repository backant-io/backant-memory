import type { MemoryDb } from "../../memory/libsql-db.js";
import {
  decayFactorForTier,
  decayEdgeFactor,
  STM_ARCHIVE_CUTOFF,
  EDGE_ARCHIVE_CUTOFF_NORMAL,
  EDGE_ARCHIVE_CUTOFF_LARGE,
} from "../../memory/decay.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";

export interface DecaySweepDeps {
  db: MemoryDb;
  cycleId?: string;
  now?: () => Date;
}

export async function decaySweep(deps: DecaySweepDeps): Promise<{
  decayed_n: number;
  archived_n: number;
  edge_decayed_n: number;
  edge_archived_n: number;
}> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;

  const stats = { decayed_n: 0, archived_n: 0, edge_decayed_n: 0, edge_archived_n: 0 };

  const stmFactor = decayFactorForTier("stm");
  const ltmFactor = decayFactorForTier("ltm");

  const decayCount = await deps.db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM memory WHERE tier IN ('stm','ltm')"
  );
  stats.decayed_n = Number(decayCount?.c ?? 0);

  // Compute the set of active epic ids — episodes under a live epic and the
  // active task_state rows themselves are exempt from decay (spec §1.1, §1.2).
  const tsRows = await deps.db.all<{ id: string; content: string }>(
    "SELECT id, content FROM memory WHERE type = 'task_state'"
  );
  const activeEpicIds = new Set<string>();
  const activeTaskStateIds = new Set<string>();
  for (const r of tsRows) {
    try {
      const c = JSON.parse(r.content) as { epic_id: string; status: string };
      if (c.status === "active") {
        activeEpicIds.add(c.epic_id);
        activeTaskStateIds.add(r.id);
      }
    } catch {
      /* malformed task_state content — treat as non-exempt */
    }
  }

  // Decay all STM except active-epic episodes; decay all LTM except active task_state.
  const allStm = await deps.db.all<{ id: string; type: string; content: string }>(
    "SELECT id, type, content FROM memory WHERE tier = 'stm'"
  );
  const exemptIds = new Set<string>();
  for (const r of allStm) {
    if (r.type !== "episode") continue;
    try {
      const c = JSON.parse(r.content) as { epic_id: string };
      if (activeEpicIds.has(c.epic_id)) exemptIds.add(r.id);
    } catch {
      /* malformed episode — let it decay */
    }
  }

  // Build a NOT IN clause for exempt STM ids. libSQL has no array binding, so
  // splice the (small) exempt id list into the statement via parameters.
  const stmExempt = Array.from(exemptIds);
  if (stmExempt.length > 0) {
    const ph = stmExempt.map((_, i) => `@e${i}`).join(",");
    const params: Record<string, string | number> = { f: stmFactor };
    stmExempt.forEach((id, i) => (params[`e${i}`] = id));
    await deps.db.run(`UPDATE memory SET weight = weight * @f WHERE tier = 'stm' AND id NOT IN (${ph})`, params);
  } else {
    await deps.db.run("UPDATE memory SET weight = weight * ? WHERE tier = 'stm'", [stmFactor]);
  }

  const tsExempt = Array.from(activeTaskStateIds);
  if (tsExempt.length > 0) {
    const ph = tsExempt.map((_, i) => `@t${i}`).join(",");
    const params: Record<string, string | number> = { f: ltmFactor };
    tsExempt.forEach((id, i) => (params[`t${i}`] = id));
    await deps.db.run(`UPDATE memory SET weight = weight * @f WHERE tier = 'ltm' AND id NOT IN (${ph})`, params);
  } else {
    await deps.db.run("UPDATE memory SET weight = weight * ? WHERE tier = 'ltm'", [ltmFactor]);
  }

  // Archive STM below cutoff, but never an exempt (active-epic) episode. The
  // active-epic exemption is enforced below via exemptIds.has(id); the
  // `retained`-tag exemption (spec §4.3) is additionally pinned here in SQL so a
  // surprise-retained episode is never even selected for archival. Both
  // exemptions co-exist.
  const toArchive = await deps.db.all<{ id: string }>(
    `SELECT id FROM memory
      WHERE tier='stm' AND weight < ?
        AND sources NOT LIKE '%"retained"%'`,
    [STM_ARCHIVE_CUTOFF]
  );
  for (const { id } of toArchive) {
    if (exemptIds.has(id)) continue;
    await deps.db.batch([
      { sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)", args: [id] },
      { sql: "DELETE FROM memory WHERE id = ?", args: [id] },
    ]);
    stats.archived_n++;
  }

  const edgeCount = await deps.db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM memory_edges WHERE status='approved'"
  );
  const totalEdges = Number(edgeCount?.c ?? 0);
  const edgeFactor = decayEdgeFactor({ totalEdges });
  const archiveCutoff = totalEdges > 10_000 ? EDGE_ARCHIVE_CUTOFF_LARGE : EDGE_ARCHIVE_CUTOFF_NORMAL;
  stats.edge_decayed_n = totalEdges;

  await deps.db.run(
    "UPDATE memory_edges SET weight = weight * ? WHERE status = 'approved'",
    [edgeFactor]
  );

  const edgeArchiveCount = await deps.db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM memory_edges WHERE status = 'approved' AND weight < ?",
    [archiveCutoff]
  );
  stats.edge_archived_n = Number(edgeArchiveCount?.c ?? 0);
  await deps.db.run(
    "DELETE FROM memory_edges WHERE status = 'approved' AND weight < ?",
    [archiveCutoff]
  );

  await deps.db.run(
    `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
     VALUES (?, 'decay_sweep', '{}', ?, ?)`,
    [cycleId, JSON.stringify(stats), now]
  );

  return stats;
}

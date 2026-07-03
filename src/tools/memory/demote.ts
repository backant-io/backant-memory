import { randomBytes } from "node:crypto";
import type { MemoryDb } from "../../memory/libsql-db.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import { DEMOTE_WEIGHT_CAP } from "../../memory/decay.js";

export interface DemoteDeps {
  db: MemoryDb;
  ltm_id: string;
  reason: string;
  cycleId?: string;
  now?: () => Date;
}

export async function demote(deps: DemoteDeps): Promise<{ stm_id: string }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;

  const src = await deps.db.get<any>(
    "SELECT * FROM memory WHERE id = ? AND tier='ltm'",
    [deps.ltm_id]
  );
  if (!src) throw new Error(`LTM entry not found: ${deps.ltm_id}`);

  const date = now.slice(0, 10);
  const stm_id = `stm_${date}_${randomBytes(4).toString("hex")}`;
  const sources = JSON.parse(src.sources) as string[];
  sources.push(`demoted-from:${src.id}`);

  await deps.db.batch([
    {
      sql: `INSERT INTO memory
              (id, repo, tier, type, content, sources, weight, created, last_reinforced,
               dream_citations, act_citations, revision_count, embedding)
            VALUES (?, ?, 'stm', ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      args: [
        stm_id,
        src.repo,
        src.type,
        src.content,
        JSON.stringify(sources),
        Math.min(src.weight, DEMOTE_WEIGHT_CAP),
        src.created,
        now,
        src.embedding,
      ],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [stm_id, src.content],
    },
    {
      sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)",
      args: [src.id],
    },
    {
      sql: "DELETE FROM memory WHERE id = ?",
      args: [src.id],
    },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
            VALUES (?, 'demote', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ ltm_id: deps.ltm_id, reason: deps.reason }),
        JSON.stringify({ stm_id }),
        now,
      ],
    },
  ]);

  return { stm_id };
}

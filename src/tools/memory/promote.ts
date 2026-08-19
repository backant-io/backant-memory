import type { MemoryDb } from "../../memory/libsql-db.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import { insertWithFreshLtmId } from "../../memory/ltm-id.js";

export interface PromoteDeps {
  db: MemoryDb;
  stm_id: string;
  reason: string;
  cycleId?: string;
  now?: () => Date;
}

export async function promote(deps: PromoteDeps): Promise<{ ltm_id: string }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;

  const src = await deps.db.get<any>(
    "SELECT * FROM memory WHERE id = ? AND tier='stm'",
    [deps.stm_id]
  );
  if (!src) throw new Error(`STM entry not found: ${deps.stm_id}`);

  const sources = JSON.parse(src.sources) as string[];
  sources.push(`promoted-from:${src.id}`);

  // Repo-scoped, repo-counted id (the old COUNT ignored repo entirely, so a
  // sibling repo's rows inflated/collided the sequence — kairos#28).
  const ltm_id = await insertWithFreshLtmId(deps.db, src.repo, src.type, async (ltm_id) => {
    await deps.db.batch([
      {
        sql: `INSERT INTO memory
                (id, repo, tier, type, content, sources, weight, created, last_reinforced,
                 dream_citations, act_citations, revision_count, embedding)
              VALUES (?, ?, 'ltm', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        args: [
          ltm_id,
          src.repo,
          src.type,
          src.content,
          JSON.stringify(sources),
          src.weight,
          src.created,
          now,
          src.dream_citations,
          src.act_citations,
          src.embedding,
        ],
      },
      {
        sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
        args: [ltm_id, src.content],
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
              VALUES (?, 'promote', ?, ?, ?)`,
        args: [
          cycleId,
          JSON.stringify({ stm_id: deps.stm_id, reason: deps.reason }),
          JSON.stringify({ ltm_id }),
          now,
        ],
      },
    ]);
  });

  return { ltm_id };
}

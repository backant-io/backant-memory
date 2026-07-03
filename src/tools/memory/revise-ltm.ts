import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";

export interface ReviseLtmDeps {
  db: MemoryDb;
  embedder: Embedder;
  id: string;
  new_content: string;
  reason: string;
  dream_source_id: string | null;
  judge_decision_cycle?: string | null;
  cycleId?: string;
  now?: () => Date;
}

export async function reviseLtm(deps: ReviseLtmDeps): Promise<{
  id: string;
  new_version: number;
  history_ref: string;
}> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;

  const current = await deps.db.get<any>(
    "SELECT * FROM memory WHERE id = ? AND tier='ltm'",
    [deps.id]
  );
  if (!current) throw new Error(`LTM entry not found: ${deps.id}`);

  const newEmbedding = await deps.embedder.embed(deps.new_content);
  const embJson = embeddingToJson(newEmbedding);
  const newVersion = Number(current.revision_count) + 1;

  await deps.db.batch([
    {
      sql: `INSERT INTO ltm_history (ltm_id, version, old_content, new_content,
                                     dream_source_id, judge_decision_cycle, reason, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        deps.id,
        newVersion,
        current.content,
        deps.new_content,
        deps.dream_source_id,
        deps.judge_decision_cycle ?? null,
        deps.reason,
        now,
      ],
    },
    {
      sql: "UPDATE memory SET content = ?, revision_count = ?, last_reinforced = ?, embedding = vector32(?) WHERE id = ?",
      args: [deps.new_content, newVersion, now, embJson, deps.id],
    },
    {
      sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)",
      args: [deps.id],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [deps.id, deps.new_content],
    },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
            VALUES (?, 'revise_ltm', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ id: deps.id, reason: deps.reason }),
        JSON.stringify({ new_version: newVersion }),
        now,
      ],
    },
  ]);

  const histRow = await deps.db.get<{ id: number }>(
    "SELECT id FROM ltm_history WHERE ltm_id = ? AND version = ?",
    [deps.id, newVersion]
  );
  const historyRowId = Number(histRow?.id ?? 0);

  return { id: deps.id, new_version: newVersion, history_ref: `hist_${historyRowId}` };
}

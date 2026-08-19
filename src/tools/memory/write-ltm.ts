import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import type { MemoryType } from "../../memory/types.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import { insertWithFreshLtmId } from "../../memory/ltm-id.js";

export interface WriteLtmInput {
  type: MemoryType;
  content: string;
  sources: string[];
  reason: string;
}

export interface WriteLtmDeps {
  db: MemoryDb;
  embedder: Embedder;
  /** Repo key (owner/repo) to stamp; defaults to db.repo. */
  repo?: string;
  cycleId?: string;
  input: WriteLtmInput;
  now?: () => Date;
}

export async function writeLtm(deps: WriteLtmDeps): Promise<{
  id: string;
  weight: number;
}> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;
  const repo = deps.repo ?? deps.db.repo;

  const json = embeddingToJson(await deps.embedder.embed(deps.input.content));

  // Repo-scoped id + retry on PK conflict: the owner-namespace db holds many
  // repos and memory.id is global (kairos#28 — a second repo's first row of a
  // type used to fail with "UNIQUE constraint failed: memory.id").
  const id = await insertWithFreshLtmId(deps.db, repo, deps.input.type, async (id) => {
    await deps.db.batch([
      {
        sql: `INSERT INTO memory
                (id, repo, tier, type, content, sources, weight, created, last_reinforced,
                 dream_citations, act_citations, revision_count, embedding)
              VALUES (?, ?, 'ltm', ?, ?, ?, 1.0, ?, ?, 0, 0, 0, vector32(?))`,
        args: [
          id,
          repo,
          deps.input.type,
          deps.input.content,
          JSON.stringify(deps.input.sources),
          now,
          now,
          json,
        ],
      },
      {
        sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
        args: [id, deps.input.content],
      },
      {
        sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
              VALUES (?, 'write_ltm', ?, ?, ?)`,
        args: [
          cycleId,
          JSON.stringify({
            type: deps.input.type,
            content_len: deps.input.content.length,
            reason: deps.input.reason,
          }),
          JSON.stringify({ id }),
          now,
        ],
      },
    ]);
  });

  return { id, weight: 1.0 };
}

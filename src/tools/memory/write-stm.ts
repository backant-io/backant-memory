import { randomBytes } from "node:crypto";
import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import type { MemoryType } from "../../memory/types.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";

export interface WriteStmInput {
  type: MemoryType;
  content: string;
  sources: string[];
}

export interface WriteStmDeps {
  db: MemoryDb;
  embedder: Embedder;
  /** Repo key (owner/repo) to stamp; defaults to db.repo. */
  repo?: string;
  cycleId?: string;
  input: WriteStmInput;
  now?: () => Date;
}

export async function writeStm(deps: WriteStmDeps): Promise<{
  id: string;
  weight: number;
  embedding_dim: number;
}> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const date = now.slice(0, 10);
  const id = `stm_${date}_${randomBytes(4).toString("hex")}`;
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;
  const repo = deps.repo ?? deps.db.repo;

  const embedding = await deps.embedder.embed(deps.input.content);
  const json = embeddingToJson(embedding);

  await deps.db.batch([
    {
      sql: `INSERT INTO memory
              (id, repo, tier, type, content, sources, weight, created, last_reinforced,
               dream_citations, act_citations, revision_count, embedding)
            VALUES (?, ?, 'stm', ?, ?, ?, 1.0, ?, ?, 0, 0, 0, vector32(?))`,
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
            VALUES (?, 'write_stm', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ type: deps.input.type, content_len: deps.input.content.length }),
        JSON.stringify({ id }),
        now,
      ],
    },
  ]);

  return { id, weight: 1.0, embedding_dim: embedding.length };
}

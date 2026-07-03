import { randomBytes } from "node:crypto";
import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import { surpriseMultiplier, type EpisodeContent } from "../../memory/episodic-types.js";

export interface WriteEpisodeDeps {
  db: MemoryDb;
  embedder: Embedder;
  repo?: string;
  cycleId?: string;
  /** Provenance tag added to sources. 'interactive' marks human-in-the-loop episodes (spec §1.4). */
  source?: string;
  input: EpisodeContent;
  now?: () => Date;
}

/**
 * Write one `episode` STM row at a decision point (spec §1.2). Weight is the
 * deterministic surprise multiplier (1.0 match / 2.0 mismatch) — no LLM
 * self-assessment. The embedding is over `situation + action_taken` so similar
 * situations retrieve the episode. Follows the write-stm batch shape; memory_fts
 * is updated by hand.
 */
export async function writeEpisode(deps: WriteEpisodeDeps): Promise<{
  id: string;
  weight: number;
  embedding_dim: number;
}> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const date = now.slice(0, 10);
  const id = `stm_${date}_${randomBytes(4).toString("hex")}`;
  const cycleId = deps.cycleId ?? deps.input.cycle_id ?? UNTRACKED_CYCLE_ID;
  const repo = deps.repo ?? deps.db.repo;

  const weight = surpriseMultiplier(deps.input.expected, deps.input.outcome);
  // Project to the EpisodeContent contract explicitly: the MCP handler forwards
  // the raw input object, which carries a top-level `source` schema property.
  // `source` is provenance — it belongs in `sources[]` only, never in content
  // (would otherwise pollute the FTS index and break the EpisodeContent shape).
  const { situation, action_type, action_taken, expected, outcome, evidence, epic_id, cycle_id } = deps.input;
  const content = JSON.stringify({ situation, action_type, action_taken, expected, outcome, evidence, epic_id, cycle_id });
  const sources = [`epic:${deps.input.epic_id}`, ...(deps.source ? [deps.source] : [])];

  const embedding = await deps.embedder.embed(`${deps.input.situation} ${deps.input.action_taken}`);
  const json = embeddingToJson(embedding);

  await deps.db.batch([
    {
      sql: `INSERT INTO memory
              (id, repo, tier, type, content, sources, weight, created, last_reinforced,
               dream_citations, act_citations, revision_count, embedding)
            VALUES (?, ?, 'stm', 'episode', ?, ?, ?, ?, ?, 0, 0, 0, vector32(?))`,
      args: [id, repo, content, JSON.stringify(sources), weight, now, now, json],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [id, content],
    },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
            VALUES (?, 'write_episode', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ action_type: deps.input.action_type, epic_id: deps.input.epic_id, outcome: deps.input.outcome }),
        JSON.stringify({ id, weight }),
        now,
      ],
    },
  ]);

  return { id, weight, embedding_dim: embedding.length };
}

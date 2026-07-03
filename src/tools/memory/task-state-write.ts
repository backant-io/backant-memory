import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import { sanitizeNamespace } from "../../memory/repo-identity.js";
import type { TaskStateContent } from "../../memory/episodic-types.js";

/**
 * Deterministic PRIMARY KEY for an epic's `task_state` row, scoped to BOTH repo and
 * epic. A namespace db is per-OWNER and holds every repo under that owner (namespace =
 * sanitized owner; the `repo` column = owner/repo), so an id of `ts_${epic_id}` alone
 * collides across repos that share an epic_id: with `memory.id` a PRIMARY KEY, the
 * second repo would either clobber the first (silent data loss + a row left stamped
 * with the wrong repo) or fail the UNIQUE constraint. Folding the sanitized repo key
 * into the id gives each (repo, epic) its own row.
 *
 * Any reader (e.g. a future taskStateRead) MUST rebuild the key with this exact
 * function so it targets the same row.
 *
 * NOTE: the sibling write-ltm.ts has the same latent collision (`ltm_${type}_NNN`,
 * a repo-filtered COUNT that still yields the same id string across repos); the same
 * repo-scoping fix is owed there. Tracked in #28 — out of this change's scope.
 */
export function taskStateId(repo: string, epicId: string): string {
  return `ts_${sanitizeNamespace(repo)}_${epicId}`;
}

/** Baseline weight for a completed task_state — released to normal LTM decay. */
const COMPLETED_BASELINE_WEIGHT = 0.5;
/** Pinned weight while the epic is active (excluded from decay in decay-sweep). */
const ACTIVE_PINNED_WEIGHT = 1.0;

export interface TaskStateWriteDeps {
  db: MemoryDb;
  embedder: Embedder;
  repo?: string;
  cycleId?: string;
  input: TaskStateContent;
  now?: () => Date;
}

/**
 * Upsert exactly one `task_state` row per (repo, epic) (spec §1.1 — "rewritten, not
 * appended"). The id is derived deterministically from repo + epic_id (see
 * {@link taskStateId}) so repeated writes overwrite the same row while different
 * repos under one owner namespace stay distinct. Weight is pinned to 1.0 while active and
 * released to a decay baseline once completed. memory_fts is updated by hand
 * (the FTS table is code-maintained, not trigger-maintained).
 */
export async function taskStateWrite(deps: TaskStateWriteDeps): Promise<{ id: string }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;
  const repo = deps.repo ?? deps.db.repo;
  const id = taskStateId(repo, deps.input.epic_id);
  const content = JSON.stringify(deps.input);
  const weight =
    deps.input.status === "active" ? ACTIVE_PINNED_WEIGHT : COMPLETED_BASELINE_WEIGHT;

  // Embed over the title so observe can recall the epic by topic.
  const json = embeddingToJson(await deps.embedder.embed(deps.input.title));

  const existing = await deps.db.get<{ id: string }>(
    "SELECT id FROM memory WHERE id = ?",
    [id]
  );

  if (existing) {
    await deps.db.batch([
      {
        sql: `UPDATE memory
                SET content = ?, weight = ?, last_reinforced = ?, embedding = vector32(?)
              WHERE id = ?`,
        args: [content, weight, now, json, id],
      },
      {
        sql: "DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)",
        args: [id],
      },
      {
        sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
        args: [id, content],
      },
      {
        sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
              VALUES (?, 'task_state_write', ?, ?, ?)`,
        args: [cycleId, JSON.stringify({ epic_id: deps.input.epic_id, status: deps.input.status }), JSON.stringify({ id }), now],
      },
    ]);
  } else {
    await deps.db.batch([
      {
        sql: `INSERT INTO memory
                (id, repo, tier, type, content, sources, weight, created, last_reinforced,
                 dream_citations, act_citations, revision_count, embedding)
              VALUES (?, ?, 'ltm', 'task_state', ?, ?, ?, ?, ?, 0, 0, 0, vector32(?))`,
        args: [id, repo, content, JSON.stringify([`epic:${deps.input.epic_id}`]), weight, now, now, json],
      },
      {
        sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
        args: [id, content],
      },
      {
        sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
              VALUES (?, 'task_state_write', ?, ?, ?)`,
        args: [cycleId, JSON.stringify({ epic_id: deps.input.epic_id, status: deps.input.status }), JSON.stringify({ id }), now],
      },
    ]);
  }

  return { id };
}

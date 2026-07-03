import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import type { ProcedureContent } from "../../memory/types.js";
import { embeddingToJson } from "../../memory/embedding-util.js";
import { UNTRACKED_CYCLE_ID } from "../../memory/constants.js";
import { embeddingTextFor, serializeProcedure } from "../../memory/procedure-content.js";
import { digestForPaths } from "../../memory/git-tree-sha.js";

export interface ProcedureProposeInput {
  name: string;
  trigger: string;
  steps: string[];
  depends_on_paths: string[];
  /**
   * Digest of the current per-path SHAs. Ignored when `cwd` is supplied (the digest is
   * computed at write time via digestForPaths — the single source of truth the sweep also
   * uses). Only used as a fallback for direct unit callers that pass no `cwd`.
   */
  validated_at_sha?: string;
  sources: string[];
}

export interface ProcedureProposeDeps {
  db: MemoryDb;
  embedder: Embedder;
  repo?: string;
  cycleId?: string;
  /**
   * Repo working directory whose git tree the dependency paths are resolved against. When
   * supplied, validated_at_sha is computed here as digestForPaths(cwd, depends_on_paths) so
   * the producer (propose) and consumer (procedureSweep) agree on format — a procedure
   * cannot then be marked stale on its first sweep without real drift. The MCP handler
   * always passes the workspace cwd.
   */
  cwd?: string;
  input: ProcedureProposeInput;
  now?: () => Date;
}

export async function procedurePropose(deps: ProcedureProposeDeps): Promise<{ id: string }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const cycleId = deps.cycleId ?? UNTRACKED_CYCLE_ID;
  const repo = deps.repo ?? deps.db.repo;

  const next = await deps.db.get<{ c: number }>(
    "SELECT COUNT(*) as c FROM memory WHERE repo = ? AND tier='ltm' AND type = 'procedure'",
    [repo]
  );
  const id = `ltm_procedure_${String(Number(next?.c ?? 0) + 1).padStart(3, "0")}`;

  // validated_at_sha is content-addressed at write time so the staleness sweep, which
  // recomputes the same digest, never falsely marks a freshly-proposed procedure stale.
  // The caller string is only honored when no cwd is available (direct unit callers).
  const validatedAtSha =
    deps.cwd !== undefined
      ? digestForPaths(deps.cwd, deps.input.depends_on_paths)
      : deps.input.validated_at_sha;
  if (validatedAtSha === undefined) {
    throw new Error("procedure_propose requires either cwd (to compute the digest) or validated_at_sha");
  }

  const content: ProcedureContent = {
    name: deps.input.name,
    trigger: deps.input.trigger,
    steps: deps.input.steps,
    depends_on_paths: deps.input.depends_on_paths,
    validated_at_sha: validatedAtSha,
    status: "proposed",
    times_applied: 0,
    success_rate: null,
  };
  const contentJson = serializeProcedure(content);
  const embJson = embeddingToJson(await deps.embedder.embed(embeddingTextFor(content)));

  await deps.db.batch([
    {
      sql: `INSERT INTO memory
              (id, repo, tier, type, content, sources, weight, created, last_reinforced,
               dream_citations, act_citations, revision_count, embedding)
            VALUES (?, ?, 'ltm', 'procedure', ?, ?, 1.0, ?, ?, 0, 0, 0, vector32(?))`,
      args: [id, repo, contentJson, JSON.stringify(deps.input.sources), now, now, embJson],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [id, contentJson],
    },
    {
      sql: `INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp)
            VALUES (?, 'procedure_propose', ?, ?, ?)`,
      args: [
        cycleId,
        JSON.stringify({ name: deps.input.name, steps: deps.input.steps.length, paths: deps.input.depends_on_paths.length }),
        JSON.stringify({ id }),
        now,
      ],
    },
  ]);

  return { id };
}

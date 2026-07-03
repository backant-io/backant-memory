import type { MemoryDb } from "./libsql-db.js";

export interface AsOfHit {
  id: string;
  content: string;
  type: string;
  tier: string;
  created: string;
  valid_from: string | null;
  valid_to: string | null;
}

/**
 * History-aware recall (spec §4.2): LIKE-match `cue` token-by-token against
 * `memory.content` and return only the rows whose validity interval
 * [coalesce(valid_from, created), valid_to) contains the `asOf` instant. Used by
 * `backant memory why --as-of`.
 *
 * Note: invalidated rows are deleted from memory_fts on supersede, so a pure
 * FTS scan cannot see them. We therefore scan the `memory` table directly with
 * a LIKE prefilter on content tokens plus the interval predicate — history must
 * see rows that current recall (and FTS) deliberately hides.
 */
export async function recallAsOf(deps: {
  db: MemoryDb;
  cue: string;
  asOf: string;
  repo?: string;
  limit?: number;
}): Promise<AsOfHit[]> {
  const repo = deps.repo ?? deps.db.repo;
  const limit = deps.limit ?? 25;
  // Token LIKE filter (history must include FTS-deleted rows, so we cannot use
  // memory_fts here). Each 3+ char token must appear in content (case-insensitive).
  const tokens = deps.cue
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  // A cue with no indexable token (e.g. "DB", "CI", "서버") has no LIKE-matchable
  // content. Without this guard `likeWhere` would be empty and the query would
  // return every row valid at asOf — silently dumping the corpus. No token to
  // match → no history hit.
  if (tokens.length === 0) return [];
  const likeClauses = tokens.map((_, i) => `LOWER(content) LIKE @tok${i}`);
  const likeWhere = `AND (${likeClauses.join(" OR ")})`;
  const params: Record<string, string> = { repo, asof: deps.asOf };
  tokens.forEach((t, i) => (params[`tok${i}`] = `%${t}%`));

  return deps.db.all<AsOfHit>(
    `SELECT id, content, type, tier, created, valid_from, valid_to
       FROM memory m
      WHERE m.repo = @repo
        ${likeWhere}
        AND COALESCE(m.valid_from, m.created) <= @asof
        AND (m.valid_to IS NULL OR @asof < m.valid_to)
      ORDER BY m.created ASC
      LIMIT ${limit}`,
    params
  );
}

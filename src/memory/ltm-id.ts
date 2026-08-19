import type { MemoryDb } from "./libsql-db.js";
import { sanitizeNamespace } from "./repo-identity.js";

/**
 * LTM ids must be unique across every repo that shares an owner namespace db
 * (`memory.id` is the global PRIMARY KEY; `memory.repo` only partitions rows).
 * Mirrors `taskStateId`: fold the sanitized repo key into the id so two repos'
 * per-(repo,type) sequences can never collide. The global store (repo "") keeps
 * the legacy `ltm_<type>_NNN` shape.
 */
export function ltmId(repo: string, type: string, seq: number): string {
  const n = String(seq).padStart(3, "0");
  const scope = repo ? `${sanitizeNamespace(repo)}_` : "";
  return `ltm_${scope}${type}_${n}`;
}

/** Per-(repo,type) next sequence number from the row count. */
export async function nextLtmSeq(db: MemoryDb, repo: string, type: string): Promise<number> {
  const row = await db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM memory WHERE repo = ? AND tier='ltm' AND type = ?",
    [repo, type],
  );
  return Number(row?.c ?? 0) + 1;
}

const MAX_ATTEMPTS = 5;

/**
 * Allocate a fresh LTM id and run `insert(id)`. If the batch fails on the
 * PRIMARY KEY (two writers counted the same n, or a legacy row squats the id),
 * advance the sequence and retry — the write must not be lost to a race.
 */
export async function insertWithFreshLtmId(
  db: MemoryDb,
  repo: string,
  type: string,
  insert: (id: string) => Promise<void>,
): Promise<string> {
  let seq = await nextLtmSeq(db, repo, type);
  for (let attempt = 0; ; attempt++) {
    const id = ltmId(repo, type, seq);
    const exists = await db.get<{ id: string }>("SELECT id FROM memory WHERE id = ?", [id]);
    if (!exists) {
      try {
        await insert(id);
        return id;
      } catch (err) {
        if (!isPkConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
    if (attempt >= MAX_ATTEMPTS) throw new Error(`could not allocate a unique LTM id for ${repo}/${type} after ${MAX_ATTEMPTS} attempts`);
    seq++;
  }
}

function isPkConflict(err: unknown): boolean {
  return /UNIQUE constraint failed: memory\.id|SQLITE_CONSTRAINT/.test(String((err as Error)?.message ?? err));
}

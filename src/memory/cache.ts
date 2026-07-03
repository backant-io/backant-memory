import { createHash } from "node:crypto";
import type { MemoryDb } from "./libsql-db.js";

export interface CacheKeyInput {
  cue: string;
  tier?: string;
  types?: string[];
  repo?: string;
}

export function cacheKey(input: CacheKeyInput): string {
  const norm = {
    cue: input.cue,
    tier: input.tier ?? "any",
    types: [...(input.types ?? [])].sort(),
    repo: input.repo ?? "",
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

export async function currentMemorySeq(db: MemoryDb): Promise<number> {
  const r = await db.get<{ s: number }>("SELECT change_seq as s FROM memory_state WHERE id = 1");
  return Number(r?.s ?? 0);
}

export async function readCache(db: MemoryDb, key: string): Promise<{
  result: unknown;
  memory_seq_at_recall: number;
} | null> {
  const row = await db.get<{ result: string; memory_seq_at_recall: number }>(
    "SELECT result, memory_seq_at_recall FROM recall_cache WHERE cue_hash = ?",
    [key]
  );
  if (!row) return null;
  return { result: JSON.parse(row.result), memory_seq_at_recall: Number(row.memory_seq_at_recall) };
}

export async function writeCache(
  db: MemoryDb,
  key: string,
  result: unknown,
  memory_seq: number
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO recall_cache (cue_hash, result, memory_seq_at_recall, created)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(cue_hash) DO UPDATE SET
       result = excluded.result,
       memory_seq_at_recall = excluded.memory_seq_at_recall,
       created = excluded.created`,
    [key, JSON.stringify(result), memory_seq, now]
  );
}

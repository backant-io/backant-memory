import type { MemoryDb } from "../../memory/libsql-db.js";

export interface RecallByIdDeps {
  db: MemoryDb;
  id: string;
}

export async function recallById(deps: RecallByIdDeps): Promise<{
  id: string;
  content: string;
  tier: string;
  type: string;
  weight: number;
  sources: string[];
} | null> {
  const row = await deps.db.get<any>(
    "SELECT id, content, tier, type, weight, sources FROM memory WHERE id = ?",
    [deps.id]
  );
  if (!row) return null;
  return { ...row, sources: JSON.parse(row.sources) };
}

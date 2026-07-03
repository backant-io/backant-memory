import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Edge } from "../../memory/types.js";

export async function edgesPending(deps: {
  db: MemoryDb;
  input: { limit?: number };
}): Promise<Edge[]> {
  const limit = deps.input.limit ?? 50;
  return await deps.db.all<Edge>(
    `SELECT * FROM memory_edges WHERE status='proposed' ORDER BY created ASC LIMIT ?`,
    [limit]
  );
}

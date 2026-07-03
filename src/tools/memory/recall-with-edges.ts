import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import { recall, type RecallHit } from "./recall.js";

export interface RecallWithEdgesInput {
  cue: string;
  k?: number;
  edge_depth?: number;
  tier?: "any" | "stm" | "ltm";
  types?: string[];
}

export interface RecallWithEdgesDeps {
  db: MemoryDb;
  embedder: Embedder;
  cycleId?: string;
  input: RecallWithEdgesInput;
}

export async function recallWithEdges(deps: RecallWithEdgesDeps): Promise<RecallHit[]> {
  const hits = await recall({
    db: deps.db,
    embedder: deps.embedder,
    cycleId: deps.cycleId,
    input: { ...deps.input, with_edges: true },
  });
  const depth = Math.max(1, deps.input.edge_depth ?? 1);
  for (const h of hits) {
    const visited = new Set<string>([h.id]);
    h.edges = await walkEdges(deps.db, [h.id], depth, visited);
  }
  return hits;
}

async function walkEdges(
  db: MemoryDb,
  ids: string[],
  remainingDepth: number,
  visited: Set<string>
): Promise<unknown[]> {
  if (remainingDepth === 0 || ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `@id${i}`).join(",");
  const params: Record<string, string> = {};
  ids.forEach((id, i) => (params[`id${i}`] = id));
  const rows = await db.all<{ id: number; from_id: string; to_id: string; edge_type: string; weight: number }>(
    `SELECT * FROM memory_edges
     WHERE status='approved' AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`,
    params
  );
  const nextIds: string[] = [];
  const out: any[] = [];
  for (const e of rows) {
    out.push(e);
    const other = ids.includes(e.from_id) ? e.to_id : e.from_id;
    if (!visited.has(other)) {
      visited.add(other);
      nextIds.push(other);
    }
  }
  return out.concat(await walkEdges(db, nextIds, remainingDepth - 1, visited));
}

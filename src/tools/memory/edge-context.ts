import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Embedder } from "../../ollama/embeddings.js";
import { recallWithEdges } from "./recall-with-edges.js";
import type { RecallHit } from "./recall.js";

export interface AttachEdgeContextDeps {
  db: MemoryDb;
  embedder: Embedder;
  cycleId?: string;
  input: { cue: string; k?: number; tier?: "any" | "stm" | "ltm"; types?: string[] };
}

export interface AnnotatedHit extends RecallHit {
  /** Compact one-hop edge lines: "<edge_type> → <neighbour content>". */
  edge_context: string[];
}

interface RawEdge {
  id: number;
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
}

export async function attachEdgeContext(deps: AttachEdgeContextDeps): Promise<AnnotatedHit[]> {
  // Reuse the existing one-hop walk (recallWithEdges, edge_depth=1) — do not re-walk by hand.
  const hits = await recallWithEdges({
    db: deps.db,
    embedder: deps.embedder,
    cycleId: deps.cycleId,
    input: { ...deps.input, edge_depth: 1 },
  });

  // Resolve neighbour content once for all referenced ids.
  const neighbourIds = new Set<string>();
  for (const h of hits) {
    for (const e of (h.edges ?? []) as RawEdge[]) {
      neighbourIds.add(e.from_id === h.id ? e.to_id : e.from_id);
    }
  }
  const contentById = new Map<string, string>();
  const ids = Array.from(neighbourIds);
  if (ids.length > 0) {
    const placeholders = ids.map((_, i) => `@id${i}`).join(",");
    const params: Record<string, string> = {};
    ids.forEach((id, i) => (params[`id${i}`] = id));
    const rows = await deps.db.all<{ id: string; content: string }>(
      `SELECT id, content FROM memory WHERE id IN (${placeholders})`,
      params
    );
    for (const r of rows) contentById.set(r.id, r.content);
  }

  return hits.map((h) => {
    const edges = (h.edges ?? []) as RawEdge[];
    const edge_context = edges.map((e) => {
      const other = e.from_id === h.id ? e.to_id : e.from_id;
      const neighbour = contentById.get(other) ?? other;
      return `${e.edge_type} → ${neighbour}`;
    });
    return { ...h, edge_context };
  });
}

import type { MemoryDb } from "../../memory/libsql-db.js";
import type { Edge, EdgeType } from "../../memory/types.js";

export interface RecallByEdgeInput {
  from?: string;
  to?: string;
  type?: EdgeType;
}

export async function recallByEdge(deps: { db: MemoryDb; input: RecallByEdgeInput }): Promise<Edge[]> {
  const where: string[] = ["status = 'approved'"];
  const params: Record<string, string> = {};
  if (deps.input.from) { where.push("from_id = @from"); params.from = deps.input.from; }
  if (deps.input.to)   { where.push("to_id = @to");     params.to   = deps.input.to; }
  if (deps.input.type) { where.push("edge_type = @type"); params.type = deps.input.type; }
  const sql = `SELECT * FROM memory_edges WHERE ${where.join(" AND ")} ORDER BY weight DESC`;
  return deps.db.all<Edge>(sql, params);
}

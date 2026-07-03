import type { MemoryDb } from "../../memory/libsql-db.js";

export interface PatternCheckInput {
  domains: string[];
}

export interface DomainStats {
  failure_count: number;
  top_signatures: { id: string; content: string }[];
  dominant_type: string | null;
}

export async function patternCheck(deps: {
  db: MemoryDb;
  input: PatternCheckInput;
}): Promise<Record<string, DomainStats>> {
  const out: Record<string, DomainStats> = {};
  for (const domain of deps.input.domains) {
    const rows = await deps.db.all<{ id: string; content: string; type: string }>(
      `SELECT id, content, type
         FROM memory
        WHERE (type='failure_signature' OR type='retry')
          AND content LIKE @needle`,
      { needle: `%${domain}%` }
    );

    const signatures = rows.filter((r) => r.type === "failure_signature").slice(0, 5)
      .map((r) => ({ id: r.id, content: r.content }));
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
    const dominant_type = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    out[domain] = {
      failure_count: rows.length,
      top_signatures: signatures,
      dominant_type,
    };
  }
  return out;
}

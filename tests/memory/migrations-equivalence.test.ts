import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { openMemoryDb } from "../../src/memory/libsql-db.js";

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Normalized structural fingerprint: whitespace-collapsed DDL of every object. */
async function fingerprint(path: string): Promise<string[]> {
  const c = createClient({ url: `file:${path}` });
  const rs = await c.execute(
    "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name"
  );
  const out = rs.rows.map(
    (r) => `${r.type}|${r.name}|${String(r.sql).replace(/\s+/g, " ").trim()}`
  );
  c.close();
  return out;
}

describe("migration chain equivalence (spec §5.3)", () => {
  it("fresh replay is structurally identical to a pre-versioning store migrated forward", async () => {
    // A: fresh store — replay the whole chain.
    const freshPath = join(tmp("bm-eq-fresh-"), "mem.db");
    await (await openMemoryDb({ localPath: freshPath })).close();

    // B: a pre-versioning store (no repo column, no Memory v2 columns), then
    //    opened through the engine so normalization + the chain run.
    const oldPath = join(tmp("bm-eq-old-"), "mem.db");
    const raw = createClient({ url: `file:${oldPath}` });
    await raw.execute(
      `CREATE TABLE memory (
        id TEXT PRIMARY KEY, tier TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
        sources TEXT NOT NULL, weight REAL NOT NULL, created TEXT NOT NULL,
        last_reinforced TEXT NOT NULL, dream_citations INTEGER NOT NULL DEFAULT 0,
        act_citations INTEGER NOT NULL DEFAULT 0, revision_count INTEGER NOT NULL DEFAULT 0,
        embedding BLOB)`
    );
    raw.close();
    await (await openMemoryDb({ localPath: oldPath })).close();

    const a = await fingerprint(freshPath);
    const b = await fingerprint(oldPath);

    // The `memory` table's CREATE statement legitimately differs in TEXT form
    // (ALTER-appended columns vs the baseline CREATE). Compare its COLUMN SET
    // instead, and require byte-equal DDL for every other object.
    const columnsOf = (fp: string[]) => {
      const line = fp.find((l) => l.startsWith("table|memory|"))!;
      return [...line.matchAll(/(?:\(|,)\s*([a-z_]+)\s+(?:TEXT|INTEGER|REAL|BLOB)/g)]
        .map((m) => m[1])
        .sort();
    };
    expect(columnsOf(b)).toEqual(columnsOf(a));
    expect(b.filter((l) => !l.startsWith("table|memory|")))
      .toEqual(a.filter((l) => !l.startsWith("table|memory|")));
  });
});

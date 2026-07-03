import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { edgeApprove } from "../../../src/tools/edges/approve.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function open() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-supersede-"));
  return openMemoryDb({ localPath: join(tempDir, ".index.db") });
}

async function insertMemory(db: any, id: string, content: string) {
  await db.batch([
    {
      sql: `INSERT INTO memory (id, repo, tier, type, content, sources, weight, created, last_reinforced)
            VALUES (?, '', 'ltm', 'lesson', ?, '[]', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      args: [id, content],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [id, content],
    },
  ]);
}

async function insertMemoryAt(db: any, id: string, content: string, created: string) {
  await db.batch([
    {
      sql: `INSERT INTO memory (id, repo, tier, type, content, sources, weight, created, last_reinforced)
            VALUES (?, '', 'ltm', 'lesson', ?, '[]', 1, ?, ?)`,
      args: [id, content, created, created],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
      args: [id, content],
    },
  ]);
}

async function insertEdge(db: any, from: string, to: string, type: string): Promise<number> {
  await db.run(
    `INSERT INTO memory_edges (from_id, to_id, edge_type, weight, status, reason, dream_source_id, created)
     VALUES (?, ?, ?, 1.0, 'proposed', 'r', NULL, '2026-01-01T00:00:00Z')`,
    [from, to, type]
  );
  const row = await db.get<{ id: number }>("SELECT last_insert_rowid() AS id");
  return Number(row!.id);
}

describe("edgeApprove — supersede invalidation", () => {
  it("approving a supersedes edge sets valid_to on the superseded row and deletes it from FTS", async () => {
    const db = await open();
    await insertMemory(db, "old_belief", "stale beats fresh content");
    await insertMemory(db, "new_belief", "the corrected content");
    const edgeId = await insertEdge(db, "new_belief", "old_belief", "supersedes");

    const seqBefore = (await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id = 1"))!.s;
    await edgeApprove({ db, edge_id: edgeId, approver_cycle: "c_sup", now: () => new Date("2026-06-11T00:00:00Z") });

    // valid_to set on the superseded (to_id) row.
    const row = await db.get<{ valid_to: string | null }>("SELECT valid_to FROM memory WHERE id = 'old_belief'");
    expect(row!.valid_to).toBe("2026-06-11T00:00:00.000Z");
    // The new belief is untouched.
    const fresh = await db.get<{ valid_to: string | null }>("SELECT valid_to FROM memory WHERE id = 'new_belief'");
    expect(fresh!.valid_to).toBeNull();
    // The superseded row is gone from FTS (no BM25 surfacing).
    const fts = await db.get<{ rowid: number }>(
      "SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'stale'"
    );
    expect(fts).toBeUndefined();
    // The new belief is still in FTS.
    const ftsNew = await db.get<{ rowid: number }>(
      "SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'corrected'"
    );
    expect(ftsNew).toBeTruthy();
    // change_seq advanced (UPDATE memory + FTS delete) so recall_cache invalidates.
    const seqAfter = (await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id = 1"))!.s;
    expect(Number(seqAfter)).toBeGreaterThan(Number(seqBefore));
    // The edge is approved.
    const edge = await db.get<{ status: string }>("SELECT status FROM memory_edges WHERE id = ?", [edgeId]);
    expect(edge!.status).toBe("approved");
  });

  it("a REVERSED supersedes edge (to = the newer row) does NOT invalidate the fresher belief", async () => {
    // Defensive guard against silent data loss: the convention is from=new, to=old.
    // If the dream LLM emits the edge reversed (to = the NEWER belief), blindly
    // invalidating to_id would destroy the fresher, correct belief. The survivor
    // must be the newer-created row regardless of edge orientation.
    const db = await open();
    await insertMemoryAt(db, "old_belief", "stale beats fresh content", "2026-01-01T00:00:00Z");
    await insertMemoryAt(db, "new_belief", "the corrected content", "2026-06-01T00:00:00Z");
    // Reversed: from = OLD, to = NEW (the newer row is wrongly in the to slot).
    const edgeId = await insertEdge(db, "old_belief", "new_belief", "supersedes");

    const res = await edgeApprove({ db, edge_id: edgeId, approver_cycle: "c_rev", now: () => new Date("2026-06-11T00:00:00Z") });

    // The fresher belief is NOT invalidated.
    const fresh = await db.get<{ valid_to: string | null }>("SELECT valid_to FROM memory WHERE id = 'new_belief'");
    expect(fresh!.valid_to).toBeNull();
    // It is still in FTS.
    const ftsNew = await db.get<{ rowid: number }>("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'corrected'");
    expect(ftsNew).toBeTruthy();
    // Nothing was invalidated.
    expect(res.invalidated_id).toBeNull();
    // The edge is still approved (the relationship is recorded; only the destructive side-effect is skipped).
    const edge = await db.get<{ status: string }>("SELECT status FROM memory_edges WHERE id = ?", [edgeId]);
    expect(edge!.status).toBe("approved");
  });

  it("approving a non-supersede edge does NOT touch valid_to or FTS", async () => {
    const db = await open();
    await insertMemory(db, "a", "alpha content");
    await insertMemory(db, "b", "beta content");
    const edgeId = await insertEdge(db, "a", "b", "supports");

    await edgeApprove({ db, edge_id: edgeId, approver_cycle: "c_sup" });

    const row = await db.get<{ valid_to: string | null }>("SELECT valid_to FROM memory WHERE id = 'b'");
    expect(row!.valid_to).toBeNull();
    const fts = await db.get<{ rowid: number }>("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'beta'");
    expect(fts).toBeTruthy();
  });
});

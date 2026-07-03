import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { recallByEdge } from "../../../src/tools/memory/recall-by-edge.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("recallByEdge", () => {
  it("returns edges matching from/to/type filters", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    await db.run(
      "INSERT INTO memory_edges (from_id, to_id, edge_type, weight, status, reason, created) VALUES (?,?,?,?,?,?,?)",
      ["a", "b", "contradicts", 1.0, "approved", "r", "2026-05-13T00:00:00Z"]
    );
    await db.run(
      "INSERT INTO memory_edges (from_id, to_id, edge_type, weight, status, reason, created) VALUES (?,?,?,?,?,?,?)",
      ["a", "c", "related_to", 1.0, "approved", "r", "2026-05-13T00:00:00Z"]
    );

    const r1 = await recallByEdge({ db, input: { from: "a", type: "contradicts" } });
    expect(r1).toHaveLength(1);
    expect(r1[0].to_id).toBe("b");

    const r2 = await recallByEdge({ db, input: { from: "a" } });
    expect(r2).toHaveLength(2);
    await db.close();
  });
});

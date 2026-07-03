import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { edgePropose } from "../../../src/tools/edges/propose.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("edgePropose", () => {
  it("inserts a proposed edge", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-ep-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    const r = await edgePropose({
      db,
      input: { from: "a", to: "b", type: "related_to", reason: "both freshness", dream_source_id: "d_x" },
    });
    expect(r.edge_id).toBeGreaterThan(0);
    const row = await db.get("SELECT * FROM memory_edges WHERE id = ?", [r.edge_id]) as any;
    expect(row.status).toBe("proposed");
    expect(row.dream_source_id).toBe("d_x");
  });
});

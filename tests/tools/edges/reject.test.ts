import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { edgePropose } from "../../../src/tools/edges/propose.js";
import { edgeReject } from "../../../src/tools/edges/reject.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("edgeReject", () => {
  it("flips status to rejected and stores the reason", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-er-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    const r = await edgePropose({
      db, input: { from: "a", to: "b", type: "related_to", reason: "weak", dream_source_id: null },
    });
    await edgeReject({ db, edge_id: r.edge_id, reason: "noise" });
    const row = await db.get("SELECT * FROM memory_edges WHERE id = ?", [r.edge_id]) as any;
    expect(row.status).toBe("rejected");
    expect(row.reason).toContain("noise");
  });
});

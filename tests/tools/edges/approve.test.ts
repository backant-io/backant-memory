import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { edgePropose } from "../../../src/tools/edges/propose.js";
import { edgeApprove } from "../../../src/tools/edges/approve.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("edgeApprove", () => {
  it("flips status to approved and sets approved_cycle", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-ea-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    const r = await edgePropose({
      db, input: { from: "a", to: "b", type: "related_to", reason: "r", dream_source_id: null },
    });
    await edgeApprove({ db, edge_id: r.edge_id, approver_cycle: "c_42" });
    const row = await db.get("SELECT * FROM memory_edges WHERE id = ?", [r.edge_id]) as any;
    expect(row.status).toBe("approved");
    expect(row.approved_cycle).toBe("c_42");
  });
});

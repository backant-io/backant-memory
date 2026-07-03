import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { edgePropose } from "../../../src/tools/edges/propose.js";
import { edgesPending } from "../../../src/tools/edges/pending.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

describe("edgesPending", () => {
  it("returns only proposed edges up to limit", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-epd-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    await edgePropose({ db, input: { from: "a", to: "b", type: "related_to", reason: "r", dream_source_id: null } });
    await edgePropose({ db, input: { from: "c", to: "d", type: "contradicts", reason: "r", dream_source_id: null } });
    const e = await edgePropose({ db, input: { from: "e", to: "f", type: "supports", reason: "r", dream_source_id: null } });
    await db.run("UPDATE memory_edges SET status='approved' WHERE id = ?", [e.edge_id]);
    expect(await edgesPending({ db, input: { limit: 10 } })).toHaveLength(2);
    expect(await edgesPending({ db, input: { limit: 1 } })).toHaveLength(1);
  });
});

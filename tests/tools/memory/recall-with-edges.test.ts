import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { recallWithEdges } from "../../../src/tools/memory/recall-with-edges.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

const fakeEmbedder = {
  async embed(text: string) {
    const v = new Float32Array(4);
    for (let i = 0; i < text.length; i++) v[i % 4] += (text.charCodeAt(i) % 13) / 10;
    return v;
  },
} as never as import("../../../src/ollama/embeddings.js").Embedder;

describe("recallWithEdges", () => {
  it("returns hits with attached edges", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    const a = await writeStm({ db, embedder: fakeEmbedder, input: { type: "observation", content: "alpha keyword", sources: [] } });
    const b = await writeStm({ db, embedder: fakeEmbedder, input: { type: "observation", content: "beta", sources: [] } });
    await db.run(
      "INSERT INTO memory_edges (from_id, to_id, edge_type, weight, status, reason, created) VALUES (?,?,?,?,?,?,?)",
      [a.id, b.id, "related_to", 1.0, "approved", "r", "2026-05-13T00:00:00Z"]
    );

    const r = await recallWithEdges({ db, embedder: fakeEmbedder, input: { cue: "alpha", k: 5, edge_depth: 1 } });
    const aHit = r.find((h) => h.id === a.id);
    expect(aHit?.edges?.length ?? 0).toBeGreaterThan(0);
    await db.close();
  });
});

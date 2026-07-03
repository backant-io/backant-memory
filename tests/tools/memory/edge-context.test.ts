import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { attachEdgeContext } from "../../../src/tools/memory/edge-context.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

const fakeEmbedder = {
  async embed(text: string) {
    const v = new Float32Array(4);
    for (let i = 0; i < text.length; i++) v[i % 4] += (text.charCodeAt(i) % 13) / 10;
    return v;
  },
} as never as import("../../../src/ollama/embeddings.js").Embedder;

describe("attachEdgeContext", () => {
  it("annotates a hit with its one-hop approved edges as prose lines", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-edgectx-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    const a = await writeStm({ db, embedder: fakeEmbedder, input: { type: "lesson", content: "alpha lesson keyword", sources: [] } });
    const b = await writeStm({ db, embedder: fakeEmbedder, input: { type: "lesson", content: "beta neighbour", sources: [] } });
    await db.run(
      "INSERT INTO memory_edges (from_id,to_id,edge_type,weight,status,reason,created) VALUES (?,?,?,?,?,?,?)",
      [a.id, b.id, "supports", 1.0, "approved", "r", "2026-05-13T00:00:00Z"]
    );

    const annotated = await attachEdgeContext({
      db, embedder: fakeEmbedder, input: { cue: "alpha", k: 5 },
    });
    const aLine = annotated.find((l) => l.id === a.id);
    expect(aLine).toBeDefined();
    // edge_context is an array of compact "supports → <neighbour content>" strings
    expect(aLine!.edge_context.some((c) => c.includes("supports") && c.includes("beta neighbour"))).toBe(true);
    await db.close();
  });

  it("returns an empty edge_context for hits with no approved edges", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-edgectx-none-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    await writeStm({ db, embedder: fakeEmbedder, input: { type: "lesson", content: "lonely keyword", sources: [] } });
    const annotated = await attachEdgeContext({
      db, embedder: fakeEmbedder, input: { cue: "lonely", k: 5 },
    });
    expect(annotated.length).toBeGreaterThan(0);
    expect(annotated[0].edge_context).toEqual([]);
    await db.close();
  });
});

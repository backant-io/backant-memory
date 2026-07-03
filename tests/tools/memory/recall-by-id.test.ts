import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { recallById } from "../../../src/tools/memory/recall-by-id.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

const fakeEmbedder = {
  async embed(text: string) {
    const v = new Float32Array(4);
    for (let i = 0; i < text.length; i++) v[i % 4] += (text.charCodeAt(i) % 13) / 10;
    return v;
  },
} as never as import("../../../src/ollama/embeddings.js").Embedder;

describe("recallById", () => {
  it("returns the entry or null", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    const e = await writeStm({
      db, embedder: fakeEmbedder,
      input: { type: "observation", content: "a", sources: [] },
    });
    const got = await recallById({ db, id: e.id });
    expect(got?.id).toBe(e.id);
    const miss = await recallById({ db, id: "nonexistent" });
    expect(miss).toBeNull();
    await db.close();
  });
});

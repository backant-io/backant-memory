import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { patternCheck } from "../../../src/tools/memory/pattern-check.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

const fakeEmbedder = {
  async embed() {
    return new Float32Array([0, 0, 0, 0]);
  },
} as never as import("../../../src/ollama/embeddings.js").Embedder;

describe("patternCheck", () => {
  it("counts failure_signatures + retries per domain (substring match in content)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });

    await writeStm({ db, embedder: fakeEmbedder, input: { type: "failure_signature", content: "freshness regressed", sources: [] } });
    await writeStm({ db, embedder: fakeEmbedder, input: { type: "retry", content: "freshness fix attempt 2", sources: [] } });
    await writeStm({ db, embedder: fakeEmbedder, input: { type: "observation", content: "freshness alert", sources: [] } });

    const r = await patternCheck({ db, input: { domains: ["freshness"] } });
    expect(r.freshness.failure_count).toBe(2);
    expect(r.freshness.top_signatures).toHaveLength(1);
    expect(r.freshness.dominant_type).toMatch(/failure_signature|retry/);
    await db.close();
  });
});

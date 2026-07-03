import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import { assertEmbeddingModel } from "../../src/memory/embedding-consistency.js";

let tempDir: string;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("assertEmbeddingModel", () => {
  it("records the model on first use and accepts a match", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await assertEmbeddingModel(db, "qwen3-embedding:0.6b", 1024);
    await expect(assertEmbeddingModel(db, "qwen3-embedding:0.6b", 1024)).resolves.toBeUndefined();
    await db.close();
  });

  it("throws loudly on a model/dim mismatch", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await assertEmbeddingModel(db, "qwen3-embedding:0.6b", 1024);
    await expect(assertEmbeddingModel(db, "other-model", 768)).rejects.toThrow(/embedding model mismatch/i);
    await db.close();
  });
});

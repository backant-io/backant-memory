import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { recall } from "../../../src/tools/memory/recall.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function setup(embeddings: Record<string, Float32Array>) {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-validity-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
  const client = new OllamaClient();
  vi.spyOn(client, "embed").mockImplementation(async ({ input }) =>
    embeddings[input] ?? new Float32Array([0, 0, 0, 0])
  );
  return { db, embedder: new Embedder({ client, model: "test" }) };
}

describe("recall — bi-temporal validity", () => {
  it("excludes invalidated (valid_to set) rows from both FTS and vector recall", async () => {
    const { db, embedder } = await setup({
      "superseded token belief": new Float32Array([1, 0, 0, 0]),
      "current token belief":    new Float32Array([1, 0, 0, 0]),
      "token query":             new Float32Array([1, 0, 0, 0]),
    });
    const a = await writeStm({ db, embedder, input: { type: "lesson", content: "superseded token belief", sources: [] } });
    await writeStm({ db, embedder, input: { type: "lesson", content: "current token belief", sources: [] } });

    // Before invalidation: both recall.
    const before = await recall({ db, embedder, input: { cue: "token query", k: 5 } });
    expect(before.map((h) => h.content).sort()).toContain("superseded token belief");

    // Invalidate the first row (as a supersede approval would).
    await db.run("UPDATE memory SET valid_to = '2026-06-11T00:00:00Z' WHERE id = ?", [a.id]);
    await db.run("DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)", [a.id]);

    const after = await recall({ db, embedder, input: { cue: "token query", k: 5 } });
    const contents = after.map((h) => h.content);
    expect(contents).not.toContain("superseded token belief");
    expect(contents).toContain("current token belief");
  });
});

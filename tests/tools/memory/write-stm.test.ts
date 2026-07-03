import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
  const client = new OllamaClient();
  vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([1, 0, 0, 0]));
  const embedder = new Embedder({ client, model: "test-model" });
  return { db, embedder };
}

describe("writeStm", () => {
  it("inserts into memory and memory_fts with a stored embedding", async () => {
    const { db, embedder } = await setup();
    const r = await writeStm({
      db,
      embedder,
      input: {
        type: "observation",
        content: "first sighting",
        sources: ["log:x"],
      },
    });
    expect(r.id).toMatch(/^stm_/);
    expect(r.weight).toBe(1.0);

    const row = await db.get("SELECT * FROM memory WHERE id = ?", [r.id]) as any;
    expect(row.tier).toBe("stm");
    expect(row.type).toBe("observation");
    expect(JSON.parse(row.sources)).toEqual(["log:x"]);
    expect(row.embedding).not.toBeNull();

    const fts = await db
      .all("SELECT * FROM memory_fts WHERE memory_fts MATCH ?", ["sighting"]);
    expect(fts.length).toBeGreaterThan(0);
  });

  it("logs the write to memory_ops_log", async () => {
    const { db, embedder } = await setup();
    await writeStm({
      db,
      embedder,
      cycleId: "c_42",
      input: { type: "observation", content: "x", sources: [] },
    });
    const log = await db
      .all("SELECT * FROM memory_ops_log WHERE op = 'write_stm'") as any[];
    expect(log).toHaveLength(1);
    expect(log[0].cycle_id).toBe("c_42");
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeLtm } from "../../../src/tools/memory/write-ltm.js";
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
  vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([0, 1, 0, 0]));
  return { db, embedder: new Embedder({ client, model: "test" }) };
}

describe("writeLtm", () => {
  it("inserts LTM entry with reason", async () => {
    const { db, embedder } = await setup();
    const r = await writeLtm({
      db,
      embedder,
      input: {
        type: "architecture",
        content: "Daemon writes via heartbeat.ts",
        sources: ["git:abc1234"],
        reason: "validated during cycle c_99",
      },
    });
    expect(r.id).toMatch(/^ltm_architecture_/);
    const row = await db.get("SELECT * FROM memory WHERE id = ?", [r.id]) as any;
    expect(row.tier).toBe("ltm");
    expect(row.weight).toBe(1.0);
  });

  it("enforces unique-per-type sequential id", async () => {
    const { db, embedder } = await setup();
    const a = await writeLtm({
      db,
      embedder,
      input: { type: "lesson", content: "A", sources: [], reason: "r" },
    });
    const b = await writeLtm({
      db,
      embedder,
      input: { type: "lesson", content: "B", sources: [], reason: "r" },
    });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^ltm_lesson_\d+$/);
    expect(b.id).toMatch(/^ltm_lesson_\d+$/);
  });

  it("ops_log args redact content but preserve type/reason/content_len", async () => {
    const { db, embedder } = await setup();
    await writeLtm({
      db,
      embedder,
      cycleId: "c_redact_test",
      input: {
        type: "lesson",
        content: "the quick brown fox jumps over the lazy dog",
        sources: ["log:x"],
        reason: "validated by judge",
      },
    });
    const log = await db
      .all("SELECT * FROM memory_ops_log WHERE op = 'write_ltm'") as any[];
    expect(log).toHaveLength(1);
    expect(log[0].cycle_id).toBe("c_redact_test");
    const args = JSON.parse(log[0].args);
    expect(args).toEqual({
      type: "lesson",
      content_len: "the quick brown fox jumps over the lazy dog".length,
      reason: "validated by judge",
    });
    expect(args.content).toBeUndefined();
    expect(args.sources).toBeUndefined();
  });
});

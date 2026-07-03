import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeLtm } from "../../../src/tools/memory/write-ltm.js";
import { reviseLtm } from "../../../src/tools/memory/revise-ltm.js";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// Deterministic 4-dim fake embedder so re-embed is observable.
function makeEmbedder() {
  const embed = vi.fn(async (text: string) => {
    const v = new Float32Array(4);
    for (let i = 0; i < text.length; i++) v[i % 4] += (text.charCodeAt(i) % 13) / 10;
    return v;
  });
  return { embed } as never as import("../../../src/ollama/embeddings.js").Embedder & { embed: typeof embed };
}

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
  const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
  return { db, embedder: makeEmbedder() };
}

describe("reviseLtm", () => {
  it("rewrites content, increments version, appends to history", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder,
      input: { type: "architecture", content: "Migrations run via direct DB", sources: [], reason: "init" },
    });
    const r = await reviseLtm({
      db, embedder,
      id: ltm.id,
      new_content: "Migrations run via heartbeat.ts",
      reason: "PR #138 moved migration runner",
      dream_source_id: "d_42",
    });

    expect(r.new_version).toBe(1);
    expect(r.history_ref).toMatch(/^hist_/);

    const row = await db.get<any>("SELECT content, revision_count FROM memory WHERE id = ?", [ltm.id]);
    expect(row.content).toBe("Migrations run via heartbeat.ts");
    expect(Number(row.revision_count)).toBe(1);

    const hist = await db.all<any>("SELECT * FROM ltm_history WHERE ltm_id = ?", [ltm.id]);
    expect(hist).toHaveLength(1);
    expect(hist[0].old_content).toBe("Migrations run via direct DB");
    expect(hist[0].new_content).toBe("Migrations run via heartbeat.ts");
    expect(hist[0].dream_source_id).toBe("d_42");
    await db.close();
  });

  it("re-embeds the new content", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder,
      input: { type: "lesson", content: "old", sources: [], reason: "r" },
    });
    await reviseLtm({
      db, embedder,
      id: ltm.id, new_content: "new", reason: "r", dream_source_id: null,
    });
    expect((embedder as any).embed).toHaveBeenCalledWith("new");
    await db.close();
  });

  it("preserves repo across revision", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder, repo: "o/r",
      input: { type: "lesson", content: "v0", sources: [], reason: "r" },
    });
    await reviseLtm({
      db, embedder,
      id: ltm.id, new_content: "v1", reason: "r", dream_source_id: null,
    });
    const row = await db.get<any>("SELECT repo FROM memory WHERE id = ?", [ltm.id]);
    expect(row.repo).toBe("o/r");
    await db.close();
  });

  it("throws when id does not exist", async () => {
    const { db, embedder } = await setup();
    await expect(
      reviseLtm({
        db, embedder,
        id: "ltm_nonexistent_000",
        new_content: "x",
        reason: "r",
        dream_source_id: null,
      })
    ).rejects.toThrow(/LTM entry not found: ltm_nonexistent_000/);
    await db.close();
  });

  it("persists judge_decision_cycle, logs to memory_ops_log, sequences versions", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder,
      input: { type: "lesson", content: "v0", sources: [], reason: "init" },
    });

    const r1 = await reviseLtm({
      db, embedder,
      cycleId: "c_rev_test",
      id: ltm.id, new_content: "v1", reason: "first rev",
      dream_source_id: "d_1",
      judge_decision_cycle: "cycle_abc",
    });
    const r2 = await reviseLtm({
      db, embedder,
      id: ltm.id, new_content: "v2", reason: "second rev",
      dream_source_id: null,
    });

    expect(r1.new_version).toBe(1);
    expect(r2.new_version).toBe(2);

    const hist = await db.all<any>(
      "SELECT * FROM ltm_history WHERE ltm_id = ? ORDER BY version ASC",
      [ltm.id]
    );
    expect(hist).toHaveLength(2);
    expect(Number(hist[0].version)).toBe(1);
    expect(hist[0].old_content).toBe("v0");
    expect(hist[0].new_content).toBe("v1");
    expect(hist[0].judge_decision_cycle).toBe("cycle_abc");
    expect(Number(hist[1].version)).toBe(2);
    expect(hist[1].old_content).toBe("v1");
    expect(hist[1].new_content).toBe("v2");
    expect(hist[1].judge_decision_cycle).toBeNull();

    const log = await db.all<any>(
      "SELECT * FROM memory_ops_log WHERE op = 'revise_ltm' ORDER BY id ASC"
    );
    expect(log).toHaveLength(2);
    expect(log[0].cycle_id).toBe("c_rev_test");
    expect(JSON.parse(log[0].args)).toEqual({ id: ltm.id, reason: "first rev" });
    expect(JSON.parse(log[0].result_summary)).toEqual({ new_version: 1 });
    expect(JSON.parse(log[1].result_summary)).toEqual({ new_version: 2 });
    await db.close();
  });

  it("history_ref references the inserted ltm_history row id", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder,
      input: { type: "lesson", content: "old", sources: [], reason: "r" },
    });
    const r = await reviseLtm({
      db, embedder,
      id: ltm.id, new_content: "new", reason: "r", dream_source_id: null,
    });
    const row = await db.get<{ id: number }>(
      "SELECT id FROM ltm_history WHERE ltm_id = ?",
      [ltm.id]
    );
    expect(r.history_ref).toBe(`hist_${Number(row!.id)}`);
    await db.close();
  });

  it("replaces memory_fts and re-embeds with new content", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder,
      input: { type: "lesson", content: "alpha banana", sources: [], reason: "r" },
    });
    await reviseLtm({
      db, embedder,
      id: ltm.id, new_content: "gamma delta", reason: "r", dream_source_id: null,
    });

    // FTS should match the new content and NOT the old content.
    const ftsNew = await db.all<any>(
      "SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?",
      ["gamma"]
    );
    expect(ftsNew.length).toBe(1);
    const ftsOld = await db.all<any>(
      "SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?",
      ["alpha"]
    );
    expect(ftsOld.length).toBe(0);

    // The embedding column remains populated and queryable for the revised row.
    const row = await db.get<{ has_emb: number }>(
      "SELECT (embedding IS NOT NULL) AS has_emb FROM memory WHERE id = ?",
      [ltm.id]
    );
    expect(Number(row?.has_emb)).toBe(1);
    await db.close();
  });
});

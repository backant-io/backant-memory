import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { writeLtm } from "../../../src/tools/memory/write-ltm.js";
import { promote } from "../../../src/tools/memory/promote.js";
import { demote } from "../../../src/tools/memory/demote.js";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// Deterministic 4-dim fake embedder: same text → same vector.
const fakeEmbedder = {
  async embed(text: string) {
    const v = new Float32Array(4);
    for (let i = 0; i < text.length; i++) v[i % 4] += (text.charCodeAt(i) % 13) / 10;
    return v;
  },
} as never as import("../../../src/ollama/embeddings.js").Embedder;

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
  const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
  return { db, embedder: fakeEmbedder };
}

describe("promote/demote", () => {
  it("promote converts an STM entry to LTM", async () => {
    const { db, embedder } = await setup();
    const stm = await writeStm({
      db, embedder,
      input: { type: "observation", content: "validated lesson", sources: ["log:x"] },
    });
    const r = await promote({ db, stm_id: stm.id, reason: "cited in 3 dreams + 2 ACT" });
    expect(r.ltm_id).toMatch(/^ltm_/);
    const row = await db.get<any>("SELECT * FROM memory WHERE id = ?", [r.ltm_id]);
    expect(row.tier).toBe("ltm");
    expect(row.content).toBe("validated lesson");

    const orig = await db.get("SELECT * FROM memory WHERE id = ?", [stm.id]);
    expect(orig).toBeUndefined();
    await db.close();
  });

  it("preserves repo across promote", async () => {
    const { db, embedder } = await setup();
    const stm = await writeStm({
      db, embedder, repo: "o/r",
      input: { type: "observation", content: "keep repo", sources: [] },
    });
    const r = await promote({ db, stm_id: stm.id, reason: "x" });
    const row = await db.get<any>("SELECT repo FROM memory WHERE id = ?", [r.ltm_id]);
    expect(row.repo).toBe("o/r");
    await db.close();
  });

  it("demote converts an LTM entry to STM", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder,
      input: { type: "lesson", content: "soft belief", sources: [], reason: "r" },
    });
    const r = await demote({ db, ltm_id: ltm.id, reason: "contradicted, low recent citations" });
    expect(r.stm_id).toMatch(/^stm_/);
    const row = await db.get<any>("SELECT * FROM memory WHERE id = ?", [r.stm_id]);
    expect(row.tier).toBe("stm");
    expect(row.content).toBe("soft belief");
    const orig = await db.get("SELECT * FROM memory WHERE id = ?", [ltm.id]);
    expect(orig).toBeUndefined();
    await db.close();
  });

  it("preserves repo across demote", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder, repo: "o/r",
      input: { type: "lesson", content: "keep repo", sources: [], reason: "r" },
    });
    const r = await demote({ db, ltm_id: ltm.id, reason: "x" });
    const row = await db.get<any>("SELECT repo FROM memory WHERE id = ?", [r.stm_id]);
    expect(row.repo).toBe("o/r");
    await db.close();
  });

  it("promote throws when stm_id does not exist", async () => {
    const { db } = await setup();
    await expect(promote({ db, stm_id: "stm_nonexistent", reason: "x" }))
      .rejects.toThrow(/STM entry not found: stm_nonexistent/);
    await db.close();
  });

  it("demote throws when ltm_id does not exist", async () => {
    const { db } = await setup();
    await expect(demote({ db, ltm_id: "ltm_nonexistent", reason: "x" }))
      .rejects.toThrow(/LTM entry not found: ltm_nonexistent/);
    await db.close();
  });

  it("promote logs to memory_ops_log and preserves citations", async () => {
    const { db, embedder } = await setup();
    const stm = await writeStm({
      db, embedder,
      input: { type: "observation", content: "x", sources: [] },
    });
    // Bump citations on the STM before promoting
    await db.run("UPDATE memory SET dream_citations = 3, act_citations = 2 WHERE id = ?", [stm.id]);

    const r = await promote({ db, cycleId: "c_promote_test", stm_id: stm.id, reason: "validated" });

    const log = await db.all<any>("SELECT * FROM memory_ops_log WHERE op = 'promote'");
    expect(log).toHaveLength(1);
    expect(log[0].cycle_id).toBe("c_promote_test");
    expect(JSON.parse(log[0].args)).toEqual({ stm_id: stm.id, reason: "validated" });
    expect(JSON.parse(log[0].result_summary)).toEqual({ ltm_id: r.ltm_id });

    const row = await db.get<any>("SELECT * FROM memory WHERE id = ?", [r.ltm_id]);
    expect(Number(row.dream_citations)).toBe(3);
    expect(Number(row.act_citations)).toBe(2);
    expect(Number(row.revision_count)).toBe(0);
    const sources = JSON.parse(row.sources) as string[];
    expect(sources).toContain(`promoted-from:${stm.id}`);
    await db.close();
  });

  it("demote caps weight at DEMOTE_WEIGHT_CAP and resets counters", async () => {
    const { db, embedder } = await setup();
    const ltm = await writeLtm({
      db, embedder,
      input: { type: "lesson", content: "old", sources: [], reason: "r" },
    });
    // Force a high-weight LTM with non-zero counters
    await db.run(
      "UPDATE memory SET weight = 1.0, dream_citations = 5, act_citations = 4, revision_count = 2 WHERE id = ?",
      [ltm.id]
    );

    const r = await demote({ db, cycleId: "c_demote_test", ltm_id: ltm.id, reason: "contradicted" });

    const row = await db.get<any>("SELECT * FROM memory WHERE id = ?", [r.stm_id]);
    expect(row.weight).toBe(0.5);
    expect(Number(row.dream_citations)).toBe(0);
    expect(Number(row.act_citations)).toBe(0);
    expect(Number(row.revision_count)).toBe(0);
    const sources = JSON.parse(row.sources) as string[];
    expect(sources).toContain(`demoted-from:${ltm.id}`);

    const log = await db.all<any>("SELECT * FROM memory_ops_log WHERE op = 'demote'");
    expect(log).toHaveLength(1);
    expect(log[0].cycle_id).toBe("c_demote_test");
    expect(JSON.parse(log[0].args)).toEqual({ ltm_id: ltm.id, reason: "contradicted" });
    await db.close();
  });

  it("promote generates sequential ltm ids per type", async () => {
    const { db, embedder } = await setup();
    const a = await writeStm({ db, embedder, input: { type: "observation", content: "a", sources: [] } });
    const b = await writeStm({ db, embedder, input: { type: "observation", content: "b", sources: [] } });

    const ra = await promote({ db, stm_id: a.id, reason: "r" });
    const rb = await promote({ db, stm_id: b.id, reason: "r" });

    // repo-scoped ids (o/r → "o-r"): unique across repos sharing one owner db
    expect(ra.ltm_id).toBe("ltm_o-r_observation_001");
    expect(rb.ltm_id).toBe("ltm_o-r_observation_002");
    await db.close();
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { writeLtm } from "../../../src/tools/memory/write-ltm.js";
import { decaySweep } from "../../../src/tools/memory/decay-sweep.js";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

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

describe("decaySweep", () => {
  it("applies tier-specific decay factors", async () => {
    const { db, embedder } = await setup();
    const stm = await writeStm({ db, embedder, input: { type: "observation", content: "a", sources: [] } });
    const ltm = await writeLtm({ db, embedder, input: { type: "lesson", content: "b", sources: [], reason: "r" } });

    await decaySweep({ db });

    const stmRow = await db.get<{ weight: number }>("SELECT weight FROM memory WHERE id = ?", [stm.id]);
    const ltmRow = await db.get<{ weight: number }>("SELECT weight FROM memory WHERE id = ?", [ltm.id]);
    expect(stmRow!.weight).toBeCloseTo(0.7);
    expect(ltmRow!.weight).toBeCloseTo(0.98);
    await db.close();
  });

  it("archives STM entries when weight drops below 0.1", async () => {
    const { db, embedder } = await setup();
    const e = await writeStm({ db, embedder, input: { type: "observation", content: "a", sources: [] } });
    await db.run("UPDATE memory SET weight = 0.12 WHERE id = ?", [e.id]);

    const r = await decaySweep({ db });

    const row = await db.get("SELECT * FROM memory WHERE id = ?", [e.id]);
    expect(row).toBeUndefined();
    expect(r.archived_n).toBe(1);
    await db.close();
  });

  it("never archives LTM regardless of weight", async () => {
    const { db, embedder } = await setup();
    const e = await writeLtm({ db, embedder, input: { type: "lesson", content: "x", sources: [], reason: "r" } });
    await db.run("UPDATE memory SET weight = 0.001 WHERE id = ?", [e.id]);

    await decaySweep({ db });

    const row = await db.get("SELECT * FROM memory WHERE id = ?", [e.id]);
    expect(row).toBeDefined();
    await db.close();
  });

  it("writes exactly one ops_log row with op='decay_sweep' and stats summary", async () => {
    const { db } = await setup();

    await decaySweep({ db, cycleId: "c_test" });

    const rows = await db.all<{ cycle_id: string; op: string; args: string; result_summary: string }>(
      "SELECT cycle_id, op, args, result_summary FROM memory_ops_log WHERE op = 'decay_sweep'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cycle_id).toBe("c_test");
    expect(rows[0].op).toBe("decay_sweep");
    expect(rows[0].args).toBe("{}");
    const summary = JSON.parse(rows[0].result_summary);
    expect(summary).toMatchObject({
      decayed_n: expect.any(Number),
      archived_n: expect.any(Number),
      edge_decayed_n: expect.any(Number),
      edge_archived_n: expect.any(Number),
    });
    await db.close();
  });

  it("decays approved edges by the normal-graph factor (0.95)", async () => {
    const { db } = await setup();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO memory_edges (from_id, to_id, edge_type, weight, status, created)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["a", "b", "supports", 1.0, "approved", now]
    );

    const r = await decaySweep({ db });

    const row = await db.get<{ weight: number }>(
      "SELECT weight FROM memory_edges WHERE from_id = 'a' AND to_id = 'b'"
    );
    expect(row!.weight).toBeCloseTo(0.95);
    expect(r.edge_decayed_n).toBe(1);
    await db.close();
  });

  it("archives approved edges that fall below the normal cutoff after decay", async () => {
    const { db } = await setup();
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO memory_edges (from_id, to_id, edge_type, weight, status, created)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["a", "b", "supports", 0.10, "approved", now]
    );

    const r = await decaySweep({ db });

    const row = await db.get("SELECT * FROM memory_edges WHERE from_id = 'a' AND to_id = 'b'");
    expect(row).toBeUndefined();
    expect(r.edge_archived_n).toBe(1);
    await db.close();
  });
});

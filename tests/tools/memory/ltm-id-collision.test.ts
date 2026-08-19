import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeLtm } from "../../../src/tools/memory/write-ltm.js";
import { writeStm } from "../../../src/tools/memory/write-stm.js";
import { promote } from "../../../src/tools/memory/promote.js";
import { procedurePropose } from "../../../src/tools/memory/procedure-propose.js";
import { ltmId } from "../../../src/memory/ltm-id.js";
import type { Embedder } from "../../../src/ollama/embeddings.js";

const fakeEmbedder = { embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]) } as unknown as Embedder;
let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

// WHY: one libSQL namespace db is per-OWNER and holds every repo under that
// owner; memory.id is the global PRIMARY KEY. Ids minted from a repo-filtered
// COUNT but without the repo in the string collide across repos — observed live
// 2026-08-19 (kairos#28): a second repo's first `gotcha` LTM failed with
// "UNIQUE constraint failed: memory.id" and the lesson was lost.
describe("LTM ids are unique across repos sharing one owner namespace", () => {
  async function twoRepos() {
    tempDir = mkdtempSync(join(tmpdir(), "ltm-id-"));
    const path = join(tempDir, "ns.db");
    const a = await openMemoryDb({ localPath: path, repo: "o/repo-a" });
    const b = await openMemoryDb({ localPath: path, repo: "o/repo-b" });
    return { a, b };
  }

  it("writeLtm: the same type in two repos mints distinct ids and both rows survive", async () => {
    const { a, b } = await twoRepos();
    const ra = await writeLtm({ db: a, embedder: fakeEmbedder, input: { type: "gotcha", content: "A", sources: [], reason: "r" } });
    const rb = await writeLtm({ db: b, embedder: fakeEmbedder, input: { type: "gotcha", content: "B", sources: [], reason: "r" } });
    expect(ra.id).not.toBe(rb.id);
    expect(ra.id).toBe(ltmId("o/repo-a", "gotcha", 1));
    expect(rb.id).toBe(ltmId("o/repo-b", "gotcha", 1));
    const rows = await a.all<{ id: string; repo: string }>("SELECT id, repo FROM memory WHERE tier='ltm' ORDER BY repo");
    expect(rows.map((r) => r.repo)).toEqual(["o/repo-a", "o/repo-b"]);
    await a.close(); await b.close();
  });

  it("promote: counts per repo and mints a repo-scoped id even when another repo already holds that type", async () => {
    const { a, b } = await twoRepos();
    await writeLtm({ db: a, embedder: fakeEmbedder, input: { type: "observation", content: "A1", sources: [], reason: "r" } });
    const stm = await writeStm({ db: b, embedder: fakeEmbedder, input: { type: "observation", content: "B-obs", sources: [] } });
    const p = await promote({ db: b, stm_id: stm.id, reason: "confirmed" });
    expect(p.ltm_id).toBe(ltmId("o/repo-b", "observation", 1));
    expect(await b.get("SELECT id FROM memory WHERE id = ?", [p.ltm_id])).toBeTruthy();
    await a.close(); await b.close();
  });

  it("procedurePropose: two repos each get their own sequence", async () => {
    const { a, b } = await twoRepos();
    const mk = (n: string) => ({ name: n, trigger: "t", steps: ["s"], depends_on_paths: [], validated_at_sha: "abc", sources: [] });
    const pa = await procedurePropose({ db: a, embedder: fakeEmbedder, input: mk("pa") });
    const pb = await procedurePropose({ db: b, embedder: fakeEmbedder, input: mk("pb") });
    expect(pa.id).toBe(ltmId("o/repo-a", "procedure", 1));
    expect(pb.id).toBe(ltmId("o/repo-b", "procedure", 1));
    await a.close(); await b.close();
  });

  it("same-repo race: if the counted id is already taken, the write advances the sequence instead of failing", async () => {
    // WHY: parallel agents (warroom) in ONE repo can both COUNT=n before either
    // inserts; the loser must not lose its memory to a constraint error.
    const { a } = await twoRepos();
    const taken = ltmId("o/repo-a", "lesson", 1);
    await a.run(
      `INSERT INTO memory (id, repo, tier, type, content, sources, weight, created, last_reinforced, dream_citations, act_citations, revision_count, embedding)
       VALUES (?, 'o/other', 'ltm', 'lesson', 'squatter', '[]', 1.0, '2026-01-01', '2026-01-01', 0, 0, 0, NULL)`, [taken]);
    const r = await writeLtm({ db: a, embedder: fakeEmbedder, input: { type: "lesson", content: "mine", sources: [], reason: "r" } });
    expect(r.id).toBe(ltmId("o/repo-a", "lesson", 2));
    await a.close();
  });

  it("legacy global store (repo '') keeps the old ltm_<type>_NNN shape", () => {
    expect(ltmId("", "lesson", 3)).toBe("ltm_lesson_003");
    expect(ltmId("backant-io/jerrycan", "gotcha", 1)).toBe("ltm_backant-io-jerrycan_gotcha_001");
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import { buildHandoffSection, readLatestHandoffBrief } from "../../src/memory/handoff-brief.js";
import { buildDigestForCwd } from "../../src/hooks/session-start-recall.js";
import { writeStm } from "../../src/tools/memory/write-stm.js";
import type { Embedder } from "../../src/ollama/embeddings.js";
import type { HandoffBriefContent } from "../../src/memory/episodic-types.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

// Deterministic fake embedder (same shape as session-start-recall.test.ts): one
// vector for every text, so a seeded row always surfaces through the real recall
// SQL with no live Ollama.
const fakeEmbedder = {
  embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
} as unknown as Embedder;

const brief = (over: Partial<HandoffBriefContent> = {}): HandoffBriefContent => ({
  active_epic: "epic-42",
  last_completed_step: "wrote the runner",
  next_action: "wire openMemoryDb",
  working_set: [{ path: "src/memory/migrations.ts", sha: "abc1234" }],
  blockers: ["ollama down"],
  do_not_redo: ["tried splitting on semicolons"],
  ...over,
});

describe("buildHandoffSection", () => {
  it("renders epic, last step, next action, working set, blockers and do-not-redo", () => {
    const s = buildHandoffSection(brief());
    expect(s).toContain("## Handoff — resume here");
    expect(s).toContain("**Active epic:** epic-42");
    expect(s).toContain("**Last completed:** wrote the runner");
    expect(s).toContain("**Next action:** wire openMemoryDb");
    expect(s).toContain("src/memory/migrations.ts@abc1234");
    expect(s).toContain("ollama down");
    expect(s).toContain("tried splitting on semicolons");
  });

  it("renders nothing for a 'none' epic or a null brief", () => {
    expect(buildHandoffSection(brief({ active_epic: "none" }))).toBe("");
    expect(buildHandoffSection(null)).toBe("");
  });
});

describe("readLatestHandoffBrief", () => {
  it("returns null when the store has no handoff_brief rows", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-handoff-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    expect(await readLatestHandoffBrief(db)).toBeNull();
    await db.close();
  });

  it("returns the most recent brief for the connection's repo", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-handoff-2-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    for (const [id, epic] of [["h1", "older"], ["h2", "newer"]] as const) {
      await db.run(
        `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
         VALUES (?,?,'stm','handoff_brief',?,'[]',1.0,'2026-01-01','2026-01-01')`,
        [id, "o/r", JSON.stringify(brief({ active_epic: epic }))]
      );
    }
    expect((await readLatestHandoffBrief(db))!.active_epic).toBe("newer");
    expect(await readLatestHandoffBrief(db, "other/repo")).toBeNull();
    await db.close();
  });
});

describe("buildDigestForCwd handoff wiring", () => {
  it("puts the handoff section first, ahead of the recalled knowledge", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bm-handoff-3-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
    await writeStm({
      db,
      embedder: fakeEmbedder,
      input: { type: "fact", content: "codebase uses hexagonal architecture", sources: [] },
    });
    await db.run(
      `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
       VALUES ('hb1','o/r','stm','handoff_brief',?,'[]',1.0,'2026-01-01','2026-01-01')`,
      [JSON.stringify(brief())]
    );

    const out = await buildDigestForCwd(tempDir, { db, embedder: fakeEmbedder });

    // ORDER IS THE POINT: an agent resuming a session must read "what am I in the
    // middle of" before the general recall, so the handoff has to open the digest
    // rather than merely appear somewhere in it.
    expect(out.indexOf("## Handoff — resume here")).toBe(0);
    expect(out).toContain("**Next action:** wire openMemoryDb");
    const recallAt = out.indexOf("## Project memory — o/r");
    expect(recallAt).toBeGreaterThan(0);
    expect(out).toContain("codebase uses hexagonal architecture");
    await db.close();
  });
});

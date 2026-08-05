import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import { buildHandoffSection, readLatestHandoffBrief } from "../../src/memory/handoff-brief.js";
import type { HandoffBriefContent } from "../../src/memory/episodic-types.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

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

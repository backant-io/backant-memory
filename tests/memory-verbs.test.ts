import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../src/memory/libsql-db.js";
import type { Embedder } from "../src/ollama/embeddings.js";
import {
  humanAge,
  recallLines,
  runEpisode,
  runRecall,
  runReinforce,
  runWrite,
  type CliStore,
} from "../src/memory-verbs.js";
import { CLI_MEMORY_VERBS } from "../src/constants.js";
import { renderUsageReport } from "../src/usage.js";

const fakeEmbedder = { embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]) } as unknown as Embedder;
let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function store(repo = "o/repo-a"): Promise<CliStore> {
  tempDir = mkdtempSync(join(tmpdir(), "memory-verbs-"));
  const db = await openMemoryDb({ localPath: join(tempDir, "ns.db"), repo });
  return { db, repo, embedder: fakeEmbedder };
}

// WHY: employees are told to reach memory through the CLI and never through MCP
// (owner ruling, hireable-employees spec §12). These four verbs are that surface,
// so each one has to reach the SAME repo-scoped store the MCP tools serve and
// carry the same defaults; a CLI that diverges quietly is worse than no CLI.
describe("the four memory verbs the office CLI exposes", () => {
  it("write --tier stm lands a row stamped with the repo, and recall finds it", async () => {
    const s = await store();
    const written = await runWrite(s, {
      tier: "stm", type: "lesson", source: "docs/thing.md",
      content: "zarquon threadbare lantern: the cue words here appear nowhere else",
    });
    expect(written.id).toMatch(/^stm_/);
    const row = await s.db.get<{ repo: string; tier: string }>(
      "SELECT repo, tier FROM memory WHERE id = ?", [written.id]
    );
    expect(row).toMatchObject({ repo: "o/repo-a", tier: "stm" });
    // A cue that exists in no other test: the recall cache keys on the cue, so a
    // shared one can return a warm result and hide a broken retrieval path.
    const lines = await runRecall(s, { cue: "zarquon threadbare lantern" });
    expect(lines.map((l) => JSON.parse(l).id)).toContain(written.id);
    await s.db.close();
  });

  it("write --tier ltm without a reason is refused, and with one it lands", async () => {
    const s = await store();
    await expect(runWrite(s, {
      tier: "ltm", type: "principle", content: "c", source: "s",
    })).rejects.toThrow(/ltm writes require a reason/);
    const ok = await runWrite(s, {
      tier: "ltm", type: "principle", content: "c", source: "s", reason: "verified twice",
    });
    expect(ok.id).toMatch(/^ltm_/);
    await s.db.close();
  });

  it("write refuses a tier outside the closed set, naming the flag", async () => {
    const s = await store();
    await expect(runWrite(s, {
      tier: "medium", type: "lesson", content: "c", source: "s",
    })).rejects.toThrow(/--tier must be one of stm\|ltm/);
    await s.db.close();
  });

  // WHY: the MCP memory_write schema leaves `type` a free string and live rows
  // carry types outside the MemoryType union. A CLI that closed the set would
  // refuse writes the store it shares already holds.
  it("write accepts a type outside the MemoryType union, as the MCP tool does", async () => {
    const s = await store();
    const written = await runWrite(s, {
      tier: "stm", type: "gotcha", content: "c", source: "s",
    });
    const row = await s.db.get<{ type: string }>("SELECT type FROM memory WHERE id = ?", [written.id]);
    expect(row?.type).toBe("gotcha");
    await expect(runWrite(s, {
      tier: "stm", type: "   ", content: "c", source: "s",
    })).rejects.toThrow(/--type must not be empty/);
    await s.db.close();
  });

  it("reinforce moves the weight and reports the number it moved it to", async () => {
    const s = await store();
    const written = await runWrite(s, {
      tier: "stm", type: "lesson", content: "c", source: "s",
    });
    expect(written.weight).toBe(1.0);
    // Weight is capped at 1.0, so a fresh write cannot go UP: the honest
    // demonstration that the verb moves the number is to move it down first.
    const down = await runReinforce(s, { id: written.id, factor: 0.5, reason: "decay" });
    expect(down.new_weight).toBe(0.5);
    const up = await runReinforce(s, { id: written.id });
    expect(up.new_weight).toBeCloseTo(0.6, 10);
    await s.db.close();
  });

  it("reinforce defaults to the act-cite category, which is what raises verdict_boost", async () => {
    const s = await store();
    const written = await runWrite(s, { tier: "stm", type: "lesson", content: "c", source: "s" });
    await runReinforce(s, { id: written.id });
    const cited = await s.db.get<{ act_citations: number; verdict_boost: number }>(
      "SELECT act_citations, verdict_boost FROM memory WHERE id = ?", [written.id]
    );
    expect(cited).toMatchObject({ act_citations: 1, verdict_boost: 1 });
    // A free-text reason is NOT a note: it is a category, and one outside the
    // citation set records no citation at all.
    await runReinforce(s, { id: written.id, reason: "because it helped" });
    const after = await s.db.get<{ act_citations: number; verdict_boost: number }>(
      "SELECT act_citations, verdict_boost FROM memory WHERE id = ?", [written.id]
    );
    expect(after).toMatchObject({ act_citations: 1, verdict_boost: 1 });
    await s.db.close();
  });

  it("reinforce on an id that is not there fails rather than reporting success", async () => {
    const s = await store();
    await expect(runReinforce(s, { id: "stm_nope" })).rejects.toThrow(/not found/);
    await s.db.close();
  });

  it("episode records the surprise weight and is recallable", async () => {
    const s = await store();
    const matched = await runEpisode(s, {
      situation: "sit", action: "act", expected: "success", outcome: "success",
    });
    expect(matched.weight).toBe(1.0);
    const surprised = await runEpisode(s, {
      situation: "grimble wafting pergola situation", action: "grimble wafting pergola action",
      expected: "success", outcome: "failure", evidence: "the log",
    });
    expect(surprised.weight).toBe(2.0);
    const lines = await runRecall(s, { cue: "grimble wafting pergola" });
    expect(lines.map((l) => JSON.parse(l).id)).toContain(surprised.id);
    await s.db.close();
  });

  it("episode refuses an outcome or expectation outside its closed set", async () => {
    const s = await store();
    await expect(runEpisode(s, {
      situation: "s", action: "a", expected: "partial", outcome: "success",
    })).rejects.toThrow(/--expected must be one of success\|failure/);
    await expect(runEpisode(s, {
      situation: "s", action: "a", expected: "success", outcome: "maybe",
    })).rejects.toThrow(/--outcome must be one of success\|failure\|partial/);
    await s.db.close();
  });

  it("recall prints exactly the five fields the skill documents, one object per line", async () => {
    const hits = [{
      id: "stm_x", content: "c", weight: 1, score: 0.5, sources: ["s"],
      type: "lesson", tier: "stm", created: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      last_reinforced: new Date().toISOString(),
    }];
    const [line] = recallLines(hits);
    expect(Object.keys(JSON.parse(line))).toEqual(["id", "tier", "type", "age", "content"]);
    expect(JSON.parse(line).age).toBe("3d");
  });

  it("an age reads at the scale it happened on, so a months-old note cannot read like yesterday", () => {
    const now = Date.UTC(2026, 0, 1);
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(humanAge(ago(5_000), now)).toBe("5s");
    expect(humanAge(ago(5 * 60_000), now)).toBe("5m");
    expect(humanAge(ago(5 * 3_600_000), now)).toBe("5h");
    expect(humanAge(ago(5 * 86_400_000), now)).toBe("5d");
    expect(humanAge(ago(120 * 86_400_000), now)).toBe("4mo");
    expect(humanAge(ago(800 * 86_400_000), now)).toBe("2y");
    expect(humanAge(undefined, now)).toBe("unknown");
  });

  it("usage names every verb the CLI registers, so the surface is discoverable from the report", () => {
    const report = renderUsageReport({
      totalSessions: 0, minTurns: 10, byEntrypoint: [], totalMemoryCalls: 0,
      totalAssistantTurns: 0, callsPer1kTurns: 0, memoryCallsByName: {}, topProjects: [],
    } as unknown as Parameters<typeof renderUsageReport>[0]);
    for (const verb of CLI_MEMORY_VERBS) {
      expect(report).toContain(`backant-memory ${verb}`);
    }
  });
});

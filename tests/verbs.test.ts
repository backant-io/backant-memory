import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb } from "../src/memory/libsql-db.js";
import { buildMemoryServer } from "../src/server.js";
import { aggregateUsage, renderUsageReport } from "../src/usage.js";
import { VERBS } from "../src/constants.js";
import {
  ageOf,
  runRecall,
  runReinforce,
  runWrite,
  runEpisode,
  type VerbSession,
} from "../src/verbs.js";

/**
 * The four shell verbs. What is worth testing here is NOT the memory engine —
 * that has its own suites — but the two claims the CLI makes on top of it:
 * a verb's effect lands in the same rows the MCP tools serve, and a verb's
 * argument shape is checked before anything is written.
 */

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
} as never as import("../src/ollama/embeddings.js").Embedder;

async function session(): Promise<VerbSession> {
  tempDir = mkdtempSync(join(tmpdir(), "bm-verbs-"));
  const db = await openMemoryDb({ localPath: join(tempDir, "mem.db"), repo: "o/r" });
  return { db, embedder: fakeEmbedder, repo: "o/r", close: () => db.close() };
}

/** The MCP surface over the SAME store and the same embedder — the other half
 *  of every round-trip below. */
function mcp(s: VerbSession) {
  return buildMemoryServer({
    workspaceCwd: process.cwd(),
    db: s.db,
    embedder: fakeEmbedder,
    repo: s.repo,
    toolProfile: "core",
  });
}

describe("verbs round-trip with the MCP tools on one store", () => {
  it("a CLI write is found by memory_recall", async () => {
    const s = await session();
    const written = await runWrite(s, {
      tier: "stm", type: "observation",
      content: "the toolbar cell is ten columns and the label truncates at nine",
      sources: ["src/screens/bar.rs"],
    });
    const server = await mcp(s);
    const out = (await server.callTool("memory_recall", { cue: "toolbar label truncates", k: 5 })) as {
      hits: Array<{ id: string }>;
    };
    expect(out.hits.map((h) => h.id)).toContain(written.id);
    await s.close();
  });

  it("a CLI reinforce moves the weight the MCP store reports", async () => {
    const s = await session();
    const { id } = await runWrite(s, {
      tier: "stm", type: "observation", content: "decayed note", sources: ["x"],
    });
    // Writes start at 1.0 and reinforce caps there, so decay the row first —
    // otherwise "moves the weight" is unobservable by construction.
    await s.db.run("UPDATE memory SET weight = 0.5 WHERE id = ?", [id]);

    const r = await runReinforce(s, { id });
    expect(r.new_weight).toBeCloseTo(0.6, 10);

    const server = await mcp(s);
    const row = await server.db.get<{ weight: number; act_citations: number; verdict_boost: number }>(
      "SELECT weight, act_citations, verdict_boost FROM memory WHERE id = ?", [id]
    );
    expect(row?.weight).toBeCloseTo(0.6, 10);
    // The default reason is 'act-cite', so the citation counter and the ranking
    // boost move too — a CLI citation must count exactly like a tool citation.
    expect(row?.act_citations).toBe(1);
    expect(row?.verdict_boost).toBe(1);
    await s.close();
  });

  it("a CLI episode appears in recall, surprise-weighted", async () => {
    const s = await session();
    const e = await runEpisode(s, {
      situation: "adding a bar entry",
      action: "added the entry and reran the golden",
      expected: "success",
      outcome: "partial",
      evidence: "the golden failed until regenerated",
    });
    expect(e.weight).toBe(2.0); // partial never matches an expectation

    const lines = await runRecall(s, { cue: "bar entry golden", k: 5 });
    const hit = lines.find((l) => l.id === e.id);
    expect(hit?.type).toBe("episode");
    expect(JSON.parse(hit!.content).action_taken).toBe("added the entry and reran the golden");

    const server = await mcp(s);
    const out = (await server.callTool("memory_recall", { cue: "bar entry golden", k: 5 })) as {
      hits: Array<{ id: string }>;
    };
    expect(out.hits.map((h) => h.id)).toContain(e.id);
    await s.close();
  });

  it("recall prints id, tier, type, age and content", async () => {
    const s = await session();
    await runWrite(s, { tier: "stm", type: "observation", content: "one line", sources: ["x"] });
    const [line] = await runRecall(s, { cue: "one line" });
    expect(Object.keys(line).sort()).toEqual(["age", "content", "id", "tier", "type"]);
    expect(line.tier).toBe("stm");
    expect(line.type).toBe("observation");
    expect(line.content).toBe("one line");
    await s.close();
  });

  it("recall honours --k", async () => {
    const s = await session();
    for (const n of ["alpha note", "alpha other", "alpha third"]) {
      await runWrite(s, { tier: "stm", type: "observation", content: n, sources: ["x"] });
    }
    expect(await runRecall(s, { cue: "alpha", k: 2 })).toHaveLength(2);
    await s.close();
  });
});

describe("verbs refuse malformed arguments before they write", () => {
  it("ltm without a reason", async () => {
    const s = await session();
    await expect(
      runWrite(s, { tier: "ltm", type: "lesson", content: "c", sources: ["x"] })
    ).rejects.toThrow(/--reason is required/);
    expect(await s.db.all("SELECT id FROM memory")).toHaveLength(0);
    await s.close();
  });

  it("ltm with a reason is written", async () => {
    const s = await session();
    const r = await runWrite(s, {
      tier: "ltm", type: "lesson", content: "c", sources: ["x"], reason: "verified twice",
    });
    expect(r.tier).toBe("ltm");
    expect(r.id.startsWith("ltm_")).toBe(true);
    await s.close();
  });

  it("an unknown tier, an empty content and a missing source", async () => {
    const s = await session();
    await expect(runWrite(s, { tier: "mtm", type: "t", content: "c", sources: ["x"] }))
      .rejects.toThrow(/--tier must be stm or ltm/);
    await expect(runWrite(s, { tier: "stm", type: "t", content: "  ", sources: ["x"] }))
      .rejects.toThrow(/--content must not be empty/);
    await expect(runWrite(s, { tier: "stm", type: "t", content: "c", sources: [] }))
      .rejects.toThrow(/--source is required/);
    await s.close();
  });

  it("an outcome or an expectation outside the closed set", async () => {
    const s = await session();
    const base = { situation: "s", action: "a", expected: "success", outcome: "success" };
    await expect(runEpisode(s, { ...base, outcome: "mostly" })).rejects.toThrow(/--outcome must be one of/);
    await expect(runEpisode(s, { ...base, expected: "partial" })).rejects.toThrow(/--expected must be/);
    await expect(runEpisode(s, { ...base, actionType: "vibes" })).rejects.toThrow(/--action-type must be one of/);
    expect(await s.db.all("SELECT id FROM memory")).toHaveLength(0);
    await s.close();
  });

  it("reinforce on an id the store does not hold", async () => {
    const s = await session();
    await expect(runReinforce(s, { id: "stm_nope" })).rejects.toThrow(/not found/);
    await s.close();
  });
});

describe("ageOf", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("reads as the unit a reader would use", () => {
    expect(ageOf(ago(3_000), now)).toBe("3s");
    expect(ageOf(ago(5 * 60_000), now)).toBe("5m");
    expect(ageOf(ago(4 * 3_600_000), now)).toBe("4h");
    expect(ageOf(ago(3 * 86_400_000), now)).toBe("3d");
    expect(ageOf(ago(70 * 86_400_000), now)).toBe("2mo");
    expect(ageOf(ago(400 * 86_400_000), now)).toBe("1y");
  });

  it("answers 'unknown' rather than NaN for a missing or unparseable stamp", () => {
    expect(ageOf(undefined, now)).toBe("unknown");
    expect(ageOf("not a date", now)).toBe("unknown");
  });

  it("never reads as the future", () => {
    expect(ageOf(new Date(now + 60_000).toISOString(), now)).toBe("0s");
  });
});

describe("usage names the verbs", () => {
  it("in both output modes", () => {
    const report = aggregateUsage([]);
    expect(report.cliVerbs).toEqual(["recall", "reinforce", "write", "episode"]);
    const text = renderUsageReport(report);
    for (const verb of VERBS) expect(text).toContain(`backant-memory ${verb}`);
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { writeEpisode } from "../../../src/tools/memory/write-episode.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";
import type { EpisodeContent } from "../../../src/memory/episodic-types.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-ep-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
  const client = new OllamaClient();
  const embedSpy = vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([1, 0, 0, 0]));
  const embedder = new Embedder({ client, model: "test-model" });
  return { db, embedder, embedSpy };
}

const ep = (over: Partial<EpisodeContent> = {}): EpisodeContent => ({
  situation: "ci failing on lint",
  action_type: "fix",
  action_taken: "ran prettier --write",
  expected: "success",
  outcome: "success",
  evidence: "ci green",
  epic_id: "e25",
  cycle_id: "c_1",
  ...over,
});

describe("writeEpisode", () => {
  it("inserts one stm/episode row with weight 1.0 when outcome matches expectation", async () => {
    const { db, embedder } = await setup();
    const r = await writeEpisode({ db, embedder, input: ep() });
    expect(r.id).toMatch(/^stm_/);
    expect(r.weight).toBe(1.0);

    const row = await db.get("SELECT * FROM memory WHERE id = ?", [r.id]) as any;
    expect(row.tier).toBe("stm");
    expect(row.type).toBe("episode");
    expect(JSON.parse(row.content).action_type).toBe("fix");
    expect(row.embedding).not.toBeNull();
  });

  it("doubles weight to 2.0 when the outcome contradicts the expectation", async () => {
    const { db, embedder } = await setup();
    const r = await writeEpisode({
      db, embedder,
      input: ep({ expected: "success", outcome: "failure" }),
    });
    expect(r.weight).toBe(2.0);
  });

  it("embeds over situation + action_taken (not the whole JSON)", async () => {
    const { db, embedder, embedSpy } = await setup();
    await writeEpisode({ db, embedder, input: ep({ situation: "S", action_taken: "A" }) });
    expect(embedSpy).toHaveBeenCalledWith({ model: "test-model", input: "S A" });
  });

  it("tags the source 'interactive' when source=interactive is passed (spec §1.4)", async () => {
    const { db, embedder } = await setup();
    const r = await writeEpisode({ db, embedder, source: "interactive", input: ep() });
    const row = await db.get("SELECT sources FROM memory WHERE id = ?", [r.id]) as any;
    expect(JSON.parse(row.sources)).toContain("interactive");
  });

  it("keeps the 'source' provenance tag out of content on the handler path (spec §1.4)", async () => {
    const { db, embedder } = await setup();
    // Mirrors server.ts: the MCP handler forwards the raw input object, which
    // carries a top-level `source` schema property, as `input`. That key must
    // land only in `sources[]`, never in the content JSON (EpisodeContent contract).
    const r = await writeEpisode({
      db,
      embedder,
      source: "interactive",
      input: { ...ep(), source: "interactive" } as unknown as EpisodeContent,
    });
    const row = await db.get("SELECT content, sources FROM memory WHERE id = ?", [r.id]) as any;
    expect(Object.keys(JSON.parse(row.content))).not.toContain("source");
    expect(JSON.parse(row.sources)).toContain("interactive");
    // And it must not be FTS-matchable on the literal provenance word via content.
    const ftsLeak = await db.all(
      "SELECT * FROM memory_fts WHERE memory_fts MATCH ?", ["interactive"]
    );
    expect(ftsLeak).toHaveLength(0);
  });

  it("indexes content into memory_fts and logs to memory_ops_log", async () => {
    const { db, embedder } = await setup();
    await writeEpisode({ db, embedder, cycleId: "c_9", input: ep({ action_taken: "ran prettier" }) });
    const fts = await db.all("SELECT * FROM memory_fts WHERE memory_fts MATCH ?", ["prettier"]);
    expect(fts.length).toBeGreaterThan(0);
    const log = await db.all("SELECT * FROM memory_ops_log WHERE op = 'write_episode'") as any[];
    expect(log).toHaveLength(1);
    expect(log[0].cycle_id).toBe("c_9");
  });
});

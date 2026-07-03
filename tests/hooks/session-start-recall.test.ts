import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRecallDigest,
  dedupeById,
  chooseCues,
  buildDigestForCwd,
} from "../../src/hooks/session-start-recall.js";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import { writeStm } from "../../src/tools/memory/write-stm.js";
import type { Embedder } from "../../src/ollama/embeddings.js";
import type { RecallHit } from "../../src/tools/memory/recall.js";

function hit(p: Partial<RecallHit>): RecallHit {
  return { id: "x", content: "c", weight: 1, score: 0.5, sources: [], type: "fact", tier: "ltm", ...p };
}

// Deterministic fake embedder: identical vector for every text, so a seeded row's
// cosine to any cue is 0 (parallel vectors) and it always surfaces via the vector
// path. Keeps the digest tests fully offline — no live Ollama, no timeout.
const fakeEmbedder = {
  embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
} as unknown as Embedder;

describe("buildRecallDigest", () => {
  it("renders a compact digest naming the repo", () => {
    const out = buildRecallDigest("backant-io/backant-send", [
      hit({ id: "a", type: "procedural", content: "builder mentality", score: 0.9 }),
      hit({ id: "b", type: "fact", content: "postal lane = cold email", score: 0.8 }),
    ]);
    expect(out).toContain("backant-io/backant-send");
    expect(out).toContain("builder mentality");
    expect(out).toContain("postal lane = cold email");
    expect(out.split("\n").length).toBeLessThan(40); // stays compact
  });

  it("returns empty string when there are no hits", () => {
    expect(buildRecallDigest("o/r", [])).toBe("");
  });

  it("caps the digest at 12 entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => hit({ id: `id${i}`, content: `c${i}`, score: i }));
    const lines = buildRecallDigest("o/r", many).split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(12);
  });
});

describe("dedupeById", () => {
  it("removes duplicate ids (first wins) and sorts by score desc", () => {
    const out = dedupeById([
      hit({ id: "a", score: 0.2 }),
      hit({ id: "a", score: 0.9 }),
      hit({ id: "b", score: 0.5 }),
    ]);
    // 'a' de-duped to its first occurrence (score 0.2); then sorted desc → b before a.
    expect(out.map((h) => h.id)).toEqual(["b", "a"]);
    expect(out[0].score).toBe(0.5);
  });
});

describe("chooseCues", () => {
  it("prepends dynamic cues from active task_state, keeping the fixed cues", () => {
    const cues = chooseCues({
      title: "auth methods",
      plan: [{ step: "add session refresh", status: "active" }],
      touched: [{ path: "src/auth/oauth.ts", sha: "abc" }],
    });
    expect(cues[0]).toBe("auth methods");
    expect(cues).toContain("add session refresh");
    expect(cues).toContain("oauth.ts");
    // Fixed cues still present as fallback breadth.
    expect(cues).toContain("known pitfalls and failure signatures");
  });

  it("falls back to exactly the fixed cues when there is no active task_state", () => {
    const cues = chooseCues(null);
    expect(cues).toEqual([
      "codebase architecture",
      "operating philosophy",
      "open priorities",
      "deployment health check command",
      "known pitfalls and failure signatures",
    ]);
  });
});

describe("buildDigestForCwd", () => {
  // Offline recall path: deterministic fake embedder, so these run without a live
  // Ollama and assert the REAL recall SQL — not the error-swallow path that a
  // missing embedder would take (that path returns "" for any input, seeded or not).
  it("recalls a seeded memory and includes its content in the digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-hook-"));
    const db = await openMemoryDb({ localPath: join(dir, "m.db") });
    await writeStm({
      db, embedder: fakeEmbedder,
      input: { type: "fact", content: "codebase uses hexagonal architecture with ports and adapters", sources: [] },
    });
    const digest = await buildDigestForCwd(dir, { db, embedder: fakeEmbedder });
    expect(digest).toContain("hexagonal architecture with ports and adapters");
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns '' when memory is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-hook-"));
    const db = await openMemoryDb({ localPath: join(dir, "m.db") });
    expect(await buildDigestForCwd(dir, { db, embedder: fakeEmbedder })).toBe("");
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

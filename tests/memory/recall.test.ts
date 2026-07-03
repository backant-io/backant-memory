import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb, type MemoryDb } from "../../src/memory/libsql-db.js";
import { recall } from "../../src/tools/memory/recall.js";
import { writeLtm } from "../../src/tools/memory/write-ltm.js";
import { embeddingToJson } from "../../src/memory/embedding-util.js";

let tempDir: string;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// Deterministic 8-dim fake embedder: same text → same vector.
const fakeEmbedder = {
  async embed(text: string) {
    const v = new Float32Array(8);
    for (let i = 0; i < text.length; i++) v[i % 8] += (text.charCodeAt(i) % 13) / 10;
    return v;
  },
} as never as import("../../src/ollama/embeddings.js").Embedder;

async function seed(db: MemoryDb, id: string, repo: string, content: string) {
  const json = embeddingToJson(await fakeEmbedder.embed(content));
  await db.batch([
    {
      sql: `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced,embedding)
            VALUES (?,?,?,?,?,?,?,?,?, vector32(?))`,
      args: [id, repo, "ltm", "fact", content, "[]", 1.0, "2026-01-01", "2026-01-01", json],
    },
    {
      sql: "INSERT INTO memory_fts(rowid,content) VALUES ((SELECT rowid FROM memory WHERE id=?), ?)",
      args: [id, content],
    },
  ]);
}

describe("recall repo scoping", () => {
  it("returns only the current repo's rows by default", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await seed(db, "a", "o/send", "postal deliverability tuning");
    await seed(db, "b", "o/warroom", "postal deliverability tuning");
    const hits = await recall({ db, embedder: fakeEmbedder, repo: "o/send", input: { cue: "postal deliverability" } });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
    await db.close();
  });

  it("with cross_repo returns same-owner rows too", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await seed(db, "a", "o/send", "postal deliverability tuning");
    await seed(db, "b", "o/warroom", "postal deliverability tuning");
    const hits = await recall({ db, embedder: fakeEmbedder, repo: "o/send", input: { cue: "postal deliverability", cross_repo: true } });
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "b"]);
    await db.close();
  });
});

describe("writeLtm", () => {
  it("stamps repo and stores a queryable embedding; recall finds it", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    const { id } = await writeLtm({
      db,
      embedder: fakeEmbedder,
      repo: "o/send",
      input: { type: "fact", content: "ship cold email first", sources: ["x"], reason: "r" },
    });
    const row = await db.get<{ repo: string; has_emb: number }>(
      "SELECT repo, (embedding IS NOT NULL) AS has_emb FROM memory WHERE id=?",
      [id]
    );
    expect(row?.repo).toBe("o/send");
    expect(Number(row?.has_emb)).toBe(1);

    const hits = await recall({ db, embedder: fakeEmbedder, repo: "o/send", input: { cue: "ship cold email" } });
    expect(hits.map((h) => h.id)).toContain(id);
    await db.close();
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import { cacheKey, readCache, writeCache, currentMemorySeq } from "../../src/memory/cache.js";

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("recall cache", () => {
  it("cacheKey is deterministic for same input", () => {
    expect(cacheKey({ cue: "x", tier: "any", types: [] })).toBe(
      cacheKey({ cue: "x", tier: "any", types: [] })
    );
    expect(cacheKey({ cue: "x", tier: "any", types: [] })).not.toBe(
      cacheKey({ cue: "y", tier: "any", types: [] })
    );
    expect(cacheKey({ cue: "x", tier: "stm", types: [] })).not.toBe(
      cacheKey({ cue: "x", tier: "ltm", types: [] })
    );
  });

  it("cacheKey is types-order independent", () => {
    expect(cacheKey({ cue: "x", types: ["a", "b"] }))
      .toBe(cacheKey({ cue: "x", types: ["b", "a"] }));
  });

  it("writeCache + readCache round-trip with integer seq", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    await writeCache(db, "abc", [{ id: "a" }], 7);
    const r = await readCache(db, "abc");
    expect(r?.memory_seq_at_recall).toBe(7);
    expect(r?.result).toEqual([{ id: "a" }]);
    await db.close();
  });

  it("readCache returns null on miss", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    expect(await readCache(db, "no")).toBeNull();
    await db.close();
  });

  it("writeCache upserts: second write overwrites", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    await writeCache(db, "abc", [{ v: 1 }], 1);
    await writeCache(db, "abc", [{ v: 2 }], 5);
    const r = await readCache(db, "abc");
    expect(r?.result).toEqual([{ v: 2 }]);
    expect(r?.memory_seq_at_recall).toBe(5);
    await db.close();
  });

  it("currentMemorySeq bumps on insert/update/delete to memory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-test-"));
    const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
    expect(await currentMemorySeq(db)).toBe(0);

    await db.run(
      "INSERT INTO memory (id,tier,type,content,sources,weight,created,last_reinforced) VALUES (?,?,?,?,?,?,?,?)",
      ["stm_a", "stm", "observation", "x", "[]", 1, "2026-05-13T00:00:00Z", "2026-05-13T00:00:00Z"]
    );
    expect(await currentMemorySeq(db)).toBe(1);

    await db.run("UPDATE memory SET weight = 0.5 WHERE id = ?", ["stm_a"]);
    expect(await currentMemorySeq(db)).toBe(2);

    await db.run("DELETE FROM memory WHERE id = ?", ["stm_a"]);
    expect(await currentMemorySeq(db)).toBe(3);
    await db.close();
  });
});

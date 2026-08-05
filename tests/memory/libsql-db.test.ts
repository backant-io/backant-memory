import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../src/memory/libsql-db.js";

let tempDir: string;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("openMemoryDb (libSQL local file)", () => {
  it("creates schema with memory + fts + meta but no memory_vec", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    const rs = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
    );
    const names = rs.map((r) => r.name);
    expect(names).toContain("memory");
    expect(names).toContain("memory_fts");
    expect(names).toContain("memory_meta");
    expect(names).toContain("memory_edges");
    expect(names).toContain("dream_bucket");
    expect(names).toContain("recall_cache");
    expect(names).toContain("memory_ops_log");
    expect(names).not.toContain("memory_vec");
    await db.close();
  });

  it("is idempotent (safe to open twice)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const path = join(tempDir, "mem.db");
    const db1 = await openMemoryDb({ localPath: path });
    await db1.close();
    const db2 = await openMemoryDb({ localPath: path });
    const row = await db2.get<{ c: number }>("SELECT COUNT(*) c FROM memory");
    expect(row?.c).toBe(0);
    await db2.close();
  });

  it("round-trips a row via run/get and bumps change_seq via trigger", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await db.run(
      `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["m1", "o/r", "ltm", "fact", "hi", "[]", 1.0, "t", "t"]
    );
    const row = await db.get<{ content: string }>("SELECT content FROM memory WHERE id=?", ["m1"]);
    expect(row?.content).toBe("hi");
    const seq = await db.get<{ change_seq: number }>("SELECT change_seq FROM memory_state WHERE id=1");
    expect(seq?.change_seq).toBe(1);
    await db.close();
  });

  it("stores and queries an embedding via vector32/vector_distance_cos", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await db.run(
      `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced,embedding)
       VALUES (?,?,?,?,?,?,?,?,?, vector32(?))`,
      ["m1", "o/r", "ltm", "fact", "hi", "[]", 1.0, "t", "t", "[0.1,0.2,0.3,0.4]"]
    );
    const row = await db.get<{ d: number }>(
      "SELECT vector_distance_cos(embedding, vector32(?)) d FROM memory WHERE id=?",
      ["[0.1,0.2,0.3,0.4]", "m1"]
    );
    expect(row!.d).toBeLessThan(0.0001); // identical vector → ~0 distance
    await db.close();
  });
});

describe("schema shape", () => {
  it("memory has a NOT NULL repo column and a repo index", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    const cols = await db.all<{ name: string; notnull: number }>("PRAGMA table_info(memory)");
    const repo = cols.find((c) => c.name === "repo");
    expect(repo).toBeDefined();
    expect(Number(repo!.notnull)).toBe(1);
    const idx = await db.all<{ name: string }>("PRAGMA index_list(memory)");
    expect(idx.map((i) => i.name)).toContain("idx_memory_repo_tier_type");
    await db.close();
  });
});

describe("openMemoryDb applies the migration chain", () => {
  it("stamps the ledger and schema_version on open", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-mig-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    const ledger = await db.all<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    expect(ledger.map((r) => r.name)).toContain("000-baseline");
    const stamp = await db.get<{ value: string }>(
      "SELECT value FROM memory_meta WHERE key='schema_version'"
    );
    expect(stamp?.value).toBe("000-baseline");
    await db.close();
  });

  it("no longer ships a schema.sql artifact next to the engine", () => {
    expect(existsSync(new URL("../../src/memory/schema.sql", import.meta.url))).toBe(false);
  });
});

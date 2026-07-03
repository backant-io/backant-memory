import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { bumpVerdictBoost } from "../../../src/tools/memory/bump-verdict-boost.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function seed(db: Awaited<ReturnType<typeof openMemoryDb>>) {
  await db.run(
    `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
     VALUES ('m1','o/r','ltm','lesson','x','[]',1.0,'2026-01-01','2026-01-01')`
  );
}

describe("bumpVerdictBoost", () => {
  it("increments verdict_boost by 1 and returns the new value", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-bump-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await seed(db);
    const r = await bumpVerdictBoost({ db, id: "m1", reason: "act-cite" });
    expect(r.new_verdict_boost).toBe(1);
    const r2 = await bumpVerdictBoost({ db, id: "m1", reason: "dream-cite" });
    expect(r2.new_verdict_boost).toBe(2);
    await db.close();
  });

  it("advances change_seq so recall_cache invalidates", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-bump-seq-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await seed(db);
    const before = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id=1");
    await bumpVerdictBoost({ db, id: "m1", reason: "act-cite" });
    const after = await db.get<{ s: number }>("SELECT change_seq AS s FROM memory_state WHERE id=1");
    expect(Number(after?.s)).toBe(Number(before?.s) + 1);
    await db.close();
  });

  it("throws when the memory id does not exist", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kairos-bump-miss-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await expect(bumpVerdictBoost({ db, id: "nope", reason: "act-cite" })).rejects.toThrow(/not found/);
    await db.close();
  });

  it("writes a bump_verdict_boost audit-log row carrying reason and new value", async () => {
    // The audit write is load-bearing for observability: deleting the
    // memory_ops_log INSERT must fail a test. Assert the row's op, the bump
    // reason, and the resulting verdict_boost all round-trip from the DB.
    tempDir = mkdtempSync(join(tmpdir(), "kairos-bump-audit-"));
    const db = await openMemoryDb({ localPath: join(tempDir, "mem.db") });
    await seed(db);
    await bumpVerdictBoost({ db, id: "m1", reason: "dream-cite" });
    const audit = await db.get<{ op: string; args: string; result_summary: string }>(
      `SELECT op, args, result_summary FROM memory_ops_log
       WHERE op = 'bump_verdict_boost' ORDER BY timestamp DESC LIMIT 1`
    );
    expect(audit?.op).toBe("bump_verdict_boost");
    expect(JSON.parse(audit!.args).reason).toBe("dream-cite");
    expect(JSON.parse(audit!.result_summary).new_verdict_boost).toBe(1);
    await db.close();
  });
});

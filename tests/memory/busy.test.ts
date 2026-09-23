import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { openMemoryDb, type MemoryDb } from "../../src/memory/libsql-db.js";
import { runMigrations } from "../../src/memory/migrations.js";

// Issue #8: hooks, sessions and the service write the same store from separate
// processes. A write that meets another process's lock must wait or retry, and
// a write that reports ok must be on disk: the old store (busy_timeout 0,
// rollback journal, no reconnect) failed most writes under contention and
// silently lost some of the ones it reported as ok.

const HOLDER = new URL("./fixtures/lock-holder.mjs", import.meta.url).pathname;

let tempDir: string;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function freshPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-mem-busy-"));
  return join(tempDir, "mem.db");
}

/** Spawn a process holding the write lock for `ms`; resolves once it holds it. */
function holdLock(path: string, ms: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HOLDER, path, String(ms)]);
    p.stdout.once("data", () => resolve(p));
    p.once("exit", (code) => code !== 0 && reject(new Error(`holder exited ${code}`)));
  });
}
const exited = (p: ChildProcess) =>
  new Promise((r) => (p.exitCode !== null ? r(null) : p.once("exit", r)));

const opsRow = (tag: string) => ({
  sql: "INSERT INTO memory_ops_log (cycle_id, op, args, result_summary, timestamp) VALUES (?, 'recall', '{}', '{}', 'x')",
  args: [tag],
});

/** What another process sees on disk, not what this connection believes. */
async function onDisk(path: string, like: string): Promise<string[]> {
  const c = createClient({ url: `file:${path}` });
  try {
    const rs = await c.execute({
      sql: "SELECT cycle_id FROM memory_ops_log WHERE cycle_id LIKE ? ORDER BY cycle_id",
      args: [like],
    });
    return rs.rows.map((r) => String(r.cycle_id));
  } finally {
    c.close();
  }
}

/** A migrated store as the old engine left it: rollback journal. */
async function toRollbackJournal(path: string) {
  const c = createClient({ url: `file:${path}` });
  await runMigrations(c);
  c.close();
}

async function pragmas(db: MemoryDb) {
  const mode = await db.get<{ journal_mode: string }>("PRAGMA journal_mode");
  const timeout = await db.get<Record<string, unknown>>("PRAGMA busy_timeout");
  return { mode: mode?.journal_mode, timeout: Number(Object.values(timeout ?? {})[0]) };
}

describe("store under cross-process write contention (issue #8)", () => {
  it("opens in WAL with busy_timeout 2000", async () => {
    const db = await openMemoryDb({ localPath: freshPath() });
    expect(await pragmas(db)).toEqual({ mode: "wal", timeout: 2000 });
    await db.close();
  });

  it("switches an existing rollback-journal store to WAL on open", async () => {
    const path = freshPath();
    await toRollbackJournal(path);
    const db = await openMemoryDb({ localPath: path });
    expect((await pragmas(db)).mode).toBe("wal");
    await db.close();
  });

  it("opens anyway when WAL cannot be switched yet, and switches on the next open", async () => {
    const path = freshPath();
    await toRollbackJournal(path);

    // Another process holds the write lock past both WAL attempts at open.
    const h = await holdLock(path, 5000);
    const db = await openMemoryDb({ localPath: path });
    expect(await pragmas(db)).toEqual({ mode: "delete", timeout: 2000 });
    await db.run(opsRow("after-open").sql, opsRow("after-open").args);
    await exited(h);
    expect(await onDisk(path, "after-open")).toEqual(["after-open"]);
    await db.close();

    const again = await openMemoryDb({ localPath: path });
    expect((await pragmas(again)).mode).toBe("wal");
    await again.close();
  }, 30_000);

  it("a single-statement write that meets BUSY reconnects, retries and lands on disk", async () => {
    const path = freshPath();
    const db = await openMemoryDb({ localPath: path });
    const reconnect = vi.spyOn(db.raw, "reconnect");
    // Held longer than busy_timeout, so the first attempt does return BUSY.
    const h = await holdLock(path, 3000);
    await db.run(opsRow("run-busy").sql, opsRow("run-busy").args);
    await exited(h);
    expect(reconnect).toHaveBeenCalled();
    expect(await onDisk(path, "run-busy")).toEqual(["run-busy"]);

    // The connection is usable afterwards and pragmas survived the reconnect.
    expect(await pragmas(db)).toEqual({ mode: "wal", timeout: 2000 });
    await db.run(opsRow("run-after").sql, opsRow("run-after").args);
    await db.batch([opsRow("batch-after")]);
    expect(await onDisk(path, "%-after")).toEqual(["batch-after", "run-after"]);
    await db.close();
  }, 30_000);

  it("a batch that meets BUSY reconnects, retries and lands on disk", async () => {
    const path = freshPath();
    const db = await openMemoryDb({ localPath: path });
    const reconnect = vi.spyOn(db.raw, "reconnect");
    const h = await holdLock(path, 3000);
    await db.batch([opsRow("batch-busy-1"), opsRow("batch-busy-2")]);
    await exited(h);
    expect(reconnect).toHaveBeenCalled();
    expect(await onDisk(path, "batch-busy-%")).toEqual(["batch-busy-1", "batch-busy-2"]);

    expect(await pragmas(db)).toEqual({ mode: "wal", timeout: 2000 });
    await db.run(opsRow("run-after").sql, opsRow("run-after").args);
    await db.batch([opsRow("batch-after")]);
    expect(await onDisk(path, "%-after")).toEqual(["batch-after", "run-after"]);
    await db.close();
  }, 30_000);

  it("surfaces BUSY after the retries run out, and the connection still works", async () => {
    const path = freshPath();
    const db = await openMemoryDb({ localPath: path });
    // Longer than 6 attempts x busy_timeout plus backoff.
    const h = await holdLock(path, 16_000);
    await expect(db.run(opsRow("never").sql, opsRow("never").args)).rejects.toThrow(/SQLITE_BUSY/);
    await exited(h);
    expect(await onDisk(path, "never")).toEqual([]);
    // The failed write left no lock behind: another connection that does not
    // wait at all can write right away.
    const other = createClient({ url: `file:${path}` });
    await other.execute(opsRow("other").sql, opsRow("other").args);
    other.close();
    await db.run(opsRow("later").sql, opsRow("later").args);
    expect(await onDisk(path, "later")).toEqual(["later"]);
    await db.close();
  }, 40_000);

  it("stress: other processes keep taking the lock; every write reported ok is on disk", async () => {
    const path = freshPath();
    const db = await openMemoryDb({ localPath: path });
    const N = 30;
    let stop = false;
    const holders = Array.from({ length: 4 }, async (_, i) => {
      while (!stop) {
        await new Promise((r) =>
          spawn(process.execPath, [HOLDER, path, String(100 + i * 100)]).once("exit", r)
        );
      }
    });

    const ok: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < N; i++) {
      const tag = `w${String(i).padStart(2, "0")}`;
      try {
        // Alternate the two write paths: autocommit run and transactional batch.
        if (i % 2) await db.batch([opsRow(tag)]);
        else await db.run(opsRow(tag).sql, opsRow(tag).args);
        ok.push(tag);
      } catch (e) {
        failed.push(`${tag}: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    stop = true;
    await Promise.all(holders);
    await db.close();

    const disk = await onDisk(path, "w%");
    expect(failed).toEqual([]);
    expect(ok).toHaveLength(N);
    expect(disk).toEqual(ok); // none lost, none phantom
  }, 120_000);
});

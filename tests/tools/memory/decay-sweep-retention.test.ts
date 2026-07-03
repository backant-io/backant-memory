import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { decaySweep } from "../../../src/tools/memory/decay-sweep.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function open() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-decay-retain-"));
  return openMemoryDb({ localPath: join(tempDir, ".index.db") });
}

async function insEpisode(db: any, id: string, weight: number, sources: string[]) {
  await db.batch([
    {
      sql: `INSERT INTO memory (id, repo, tier, type, content, sources, weight, created, last_reinforced)
            VALUES (?, '', 'stm', 'episode', '{}', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      args: [id, JSON.stringify(sources), weight],
    },
    {
      sql: "INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), '{}')",
      args: [id],
    },
  ]);
}

describe("decaySweep — surprise retention exemption", () => {
  it("does not archive a retained episode even when its decayed weight drops below the cutoff", async () => {
    const db = await open();
    // Both start below the archive cutoff after one decay; one is retained.
    await insEpisode(db, "retained_ep", 0.05, ["epic:done", "retained"]);
    await insEpisode(db, "plain_ep", 0.05, ["epic:done"]);

    await decaySweep({ db });

    const retained = await db.get<{ id: string }>("SELECT id FROM memory WHERE id = 'retained_ep'");
    expect(retained).toBeTruthy(); // survived
    const plain = await db.get<{ id: string }>("SELECT id FROM memory WHERE id = 'plain_ep'");
    expect(plain).toBeUndefined(); // archived
  });
});

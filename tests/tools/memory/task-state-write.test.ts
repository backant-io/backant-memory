import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { taskStateWrite, taskStateId } from "../../../src/tools/memory/task-state-write.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";
import type { TaskStateContent } from "../../../src/memory/episodic-types.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-ts-write-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
  const client = new OllamaClient();
  vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([1, 0, 0, 0]));
  const embedder = new Embedder({ client, model: "test-model" });
  return { db, embedder };
}

const baseState = (over: Partial<TaskStateContent> = {}): TaskStateContent => ({
  epic_id: "e25",
  title: "auth methods",
  status: "active",
  plan: [{ step: "oauth", status: "active" }],
  open_threads: [],
  touched: [],
  blockers: [],
  ...over,
});

describe("taskStateWrite", () => {
  it("writes one ltm/task_state row with a deterministic id per epic", async () => {
    const { db, embedder } = await setup();
    const r = await taskStateWrite({ db, embedder, input: baseState() });
    // id is repo-scoped (db.repo === "" here); rebuilt via taskStateId, not hardcoded.
    expect(r.id).toBe(taskStateId("", "e25"));

    const row = await db.get("SELECT * FROM memory WHERE id = ?", [r.id]) as any;
    expect(row.tier).toBe("ltm");
    expect(row.type).toBe("task_state");
    expect(JSON.parse(row.content).title).toBe("auth methods");
    expect(row.weight).toBe(1.0);
    expect(row.embedding).not.toBeNull();
  });

  it("rewrites the same row (no append) on a second write for the same epic", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, input: baseState() });
    await taskStateWrite({
      db, embedder,
      input: baseState({ blockers: ["waiting on review"] }),
    });

    const rows = await db.all("SELECT * FROM memory WHERE type = 'task_state'") as any[];
    expect(rows).toHaveLength(1); // rewritten, not appended
    expect(JSON.parse(rows[0].content).blockers).toEqual(["waiting on review"]);
  });

  it("keeps memory_fts in sync on rewrite (no stale duplicate rows)", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, input: baseState({ title: "alpha topic" }) });
    await taskStateWrite({ db, embedder, input: baseState({ title: "beta topic" }) });

    const stale = await db.all(
      "SELECT * FROM memory_fts WHERE memory_fts MATCH ?", ["alpha"]
    );
    expect(stale).toHaveLength(0);
    const fresh = await db.all(
      "SELECT * FROM memory_fts WHERE memory_fts MATCH ?", ["beta"]
    );
    expect(fresh.length).toBeGreaterThan(0);
  });

  it("pins weight to 1.0 on an active rewrite even after manual decay", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, input: baseState() });
    const id = taskStateId("", "e25");
    await db.run("UPDATE memory SET weight = 0.2 WHERE id = ?", [id]);
    await taskStateWrite({ db, embedder, input: baseState({ blockers: ["x"] }) });
    const row = await db.get("SELECT weight FROM memory WHERE id = ?", [id]) as any;
    expect(row.weight).toBe(1.0);
  });

  it("demotes weight (no longer pinned) when status flips to completed", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, input: baseState() });
    await taskStateWrite({ db, embedder, input: baseState({ status: "completed" }) });
    const row = await db.get("SELECT weight FROM memory WHERE id = ?", [taskStateId("", "e25")]) as any;
    // completed rows are released to normal decay: written at a non-pinned baseline
    expect(row.weight).toBe(0.5);
  });

  it("logs the write to memory_ops_log", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, cycleId: "c_7", input: baseState() });
    const log = await db.all("SELECT * FROM memory_ops_log WHERE op = 'task_state_write'") as any[];
    expect(log).toHaveLength(1);
    expect(log[0].cycle_id).toBe("c_7");
  });

  // A namespace db is per-OWNER and holds every repo under that owner (namespace =
  // sanitized owner; `repo` column = owner/repo). Two repos sharing the SAME epic_id
  // must not collide into one row: repoB's write must never clobber repoA's task_state,
  // and each row must stay stamped with its own repo (spec §1.1 — all rows repo-stamped,
  // repo-filtered recall). Regression for the cross-repo PK collision / silent data loss.
  it("keeps per-repo rows distinct when two repos share an epic_id in one owner db", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({
      db, embedder, repo: "owner/repoA",
      input: baseState({ title: "A-side" }),
    });
    await taskStateWrite({
      db, embedder, repo: "owner/repoB",
      input: baseState({ title: "B-side" }),
    });

    const rows = await db.all(
      "SELECT id, repo, content FROM memory WHERE type = 'task_state' ORDER BY repo"
    ) as any[];
    expect(rows).toHaveLength(2); // two repos -> two rows, no clobber

    const byRepo = new Map(rows.map((r) => [r.repo, JSON.parse(r.content).title]));
    expect(byRepo.get("owner/repoA")).toBe("A-side"); // repoA survived repoB's write
    expect(byRepo.get("owner/repoB")).toBe("B-side");

    // ids must differ so the PRIMARY KEY can hold both rows at once.
    expect(rows[0].id).not.toBe(rows[1].id);

    // A repo-filtered read must return that repo's own data, not the other's.
    const a = await db.get(
      "SELECT content FROM memory WHERE type = 'task_state' AND repo = ?",
      ["owner/repoA"]
    ) as any;
    expect(JSON.parse(a.content).title).toBe("A-side");
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { taskStateWrite } from "../../../src/tools/memory/task-state-write.js";
import { taskStateRead } from "../../../src/tools/memory/task-state-read.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";
import type { TaskStateContent } from "../../../src/memory/episodic-types.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-ts-read-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db") });
  const client = new OllamaClient();
  vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([1, 0, 0, 0]));
  const embedder = new Embedder({ client, model: "test-model" });
  return { db, embedder };
}

const st = (over: Partial<TaskStateContent>): TaskStateContent => ({
  epic_id: "e1", title: "t", status: "active",
  plan: [], open_threads: [], touched: [], blockers: [], ...over,
});

describe("taskStateRead", () => {
  it("returns one epic's parsed task_state content by epic_id", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, input: st({ epic_id: "e25", title: "auth" }) });
    const r = await taskStateRead({ db, input: { epic_id: "e25" } });
    expect(r.state?.epic_id).toBe("e25");
    expect(r.state?.title).toBe("auth");
  });

  it("returns null state for an unknown epic", async () => {
    const { db } = await setup();
    const r = await taskStateRead({ db, input: { epic_id: "nope" } });
    expect(r.state).toBeNull();
  });

  it("lists only active epics when no epic_id is given", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, input: st({ epic_id: "a", status: "active" }) });
    await taskStateWrite({ db, embedder, input: st({ epic_id: "b", status: "completed" }) });
    await taskStateWrite({ db, embedder, input: st({ epic_id: "c", status: "active" }) });
    const r = await taskStateRead({ db, input: {} });
    expect(r.active.map((s) => s.epic_id).sort()).toEqual(["a", "c"]);
  });

  // A namespace db is per-OWNER and holds every repo under that owner, so two repos
  // sharing one epic_id own DISTINCT rows (taskStateId folds the sanitized repo into
  // the id; see task-state-write 295ab06/5994d01). The single-epic read MUST rebuild
  // that repo-scoped key, not `ts_${epic_id}`, or it returns the wrong repo's state to
  // the handoff assembler (which calls taskStateRead with an explicit repo). Reverting
  // the read to `ts_${epic_id}` would make this fail.
  it("reads the repo's own row when two repos share an epic_id", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, repo: "owner/repoA", input: st({ epic_id: "shared", title: "A-side" }) });
    await taskStateWrite({ db, embedder, repo: "owner/repoB", input: st({ epic_id: "shared", title: "B-side" }) });

    const a = await taskStateRead({ db, repo: "owner/repoA", input: { epic_id: "shared" } });
    expect(a.state?.title).toBe("A-side");
    const b = await taskStateRead({ db, repo: "owner/repoB", input: { epic_id: "shared" } });
    expect(b.state?.title).toBe("B-side");
  });

  // List mode is repo-filtered too (WHERE repo = ?): one repo's active epics must not
  // leak into another repo's handoff list under the shared owner namespace.
  it("lists only the queried repo's active epics across two repos", async () => {
    const { db, embedder } = await setup();
    await taskStateWrite({ db, embedder, repo: "owner/repoA", input: st({ epic_id: "a1", status: "active" }) });
    await taskStateWrite({ db, embedder, repo: "owner/repoA", input: st({ epic_id: "a2", status: "active" }) });
    await taskStateWrite({ db, embedder, repo: "owner/repoB", input: st({ epic_id: "b1", status: "active" }) });

    const r = await taskStateRead({ db, repo: "owner/repoA", input: {} });
    expect(r.active.map((s) => s.epic_id).sort()).toEqual(["a1", "a2"]);
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { procedurePropose } from "../../../src/tools/memory/procedure-propose.js";
import { procedureSweep, digestForPaths } from "../../../src/tools/procedures/procedure-sweep.js";
import { parseProcedure } from "../../../src/memory/procedure-content.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";

let workDir: string;
let memDir: string;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (memDir) rmSync(memDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function setup() {
  workDir = mkdtempSync(join(tmpdir(), "kairos-sweep-work-"));
  git(workDir, "init", "-q");
  git(workDir, "config", "user.email", "t@t.io");
  git(workDir, "config", "user.name", "t");
  writeFileSync(join(workDir, "deploy.sh"), "echo v1\n");
  git(workDir, "add", "deploy.sh");
  git(workDir, "commit", "-q", "-m", "v1");

  memDir = mkdtempSync(join(tmpdir(), "kairos-sweep-mem-"));
  const db = await openMemoryDb({ localPath: join(memDir, ".index.db"), repo: "o/r" });
  const client = new OllamaClient();
  vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([0, 1, 0, 0]));
  return { db, embedder: new Embedder({ client, model: "test" }) };
}

async function makeValidated(db: any, embedder: any, cwd: string) {
  const sha = digestForPaths(cwd, ["deploy.sh"]);
  const { id } = await procedurePropose({
    db, embedder,
    input: { name: "deploy", trigger: "t", steps: ["run {deploy.sh}"],
             depends_on_paths: ["deploy.sh"], validated_at_sha: sha, sources: [] },
  });
  const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
  await db.run("UPDATE memory SET content = ? WHERE id = ?",
    [JSON.stringify({ ...parseProcedure(row.content), status: "validated" }), id]);
  return id;
}

describe("procedureSweep", () => {
  it("marks a validated procedure stale when a dependency drifts", async () => {
    const { db, embedder } = await setup();
    const id = await makeValidated(db, embedder, workDir);
    writeFileSync(join(workDir, "deploy.sh"), "echo v2-CHANGED\n"); // drift (working tree)
    const r = await procedureSweep({ db, cwd: workDir });
    expect(r.marked_stale).toContain(id);
    const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
    expect(parseProcedure(row.content).status).toBe("stale");
  });

  it("leaves a validated procedure validated when no dependency drifted", async () => {
    const { db, embedder } = await setup();
    const id = await makeValidated(db, embedder, workDir);
    const r = await procedureSweep({ db, cwd: workDir });
    expect(r.marked_stale).not.toContain(id);
    const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
    expect(parseProcedure(row.content).status).toBe("validated");
  });

  it("propose computes validated_at_sha so the first sweep with no edits keeps it validated", async () => {
    // Round-trip: the producer (procedurePropose, given cwd) and the consumer
    // (procedureSweep) must derive validated_at_sha through the SAME digestForPaths, so a
    // procedure proposed against a real repo does NOT falsely go stale on its first sweep.
    // The status is flipped to validated WITHOUT re-seeding validated_at_sha — the
    // propose-computed digest is what gets verified.
    const { db, embedder } = await setup();
    const { id } = await procedurePropose({
      db, embedder, cwd: workDir,
      input: { name: "deploy", trigger: "t", steps: ["run {deploy.sh}"],
               depends_on_paths: ["deploy.sh"], sources: [] },
    });
    const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
    await db.run("UPDATE memory SET content = ? WHERE id = ?",
      [JSON.stringify({ ...parseProcedure(row.content), status: "validated" }), id]);

    const r = await procedureSweep({ db, cwd: workDir });
    expect(r.marked_stale).not.toContain(id);
    const after = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
    expect(parseProcedure(after.content).status).toBe("validated");
  });

  it("ignores proposed/stale/archived procedures (only validated are swept)", async () => {
    const { db, embedder } = await setup();
    const { id } = await procedurePropose({
      db, embedder,
      input: { name: "p", trigger: "t", steps: ["x"], depends_on_paths: ["deploy.sh"],
               validated_at_sha: "stale-sha", sources: [] },
    }); // status proposed
    const r = await procedureSweep({ db, cwd: workDir });
    expect(r.marked_stale).not.toContain(id);
    const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
    expect(parseProcedure(row.content).status).toBe("proposed");
  });

  it("treats a deleted dependency path as drift", async () => {
    const { db, embedder } = await setup();
    const id = await makeValidated(db, embedder, workDir);
    rmSync(join(workDir, "deploy.sh"));
    const r = await procedureSweep({ db, cwd: workDir });
    expect(r.marked_stale).toContain(id);
  });

  it("skips a procedure with malformed content without aborting the sweep", async () => {
    const { db, embedder } = await setup();
    // A corrupt procedure row must not block staleness detection for the rest.
    await db.run(
      `INSERT INTO memory (id,repo,tier,type,content,sources,weight,created,last_reinforced)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["corrupt", "o/r", "ltm", "procedure", "{not valid json", "[]", 1.0, "t", "t"]
    );
    const id = await makeValidated(db, embedder, workDir);
    writeFileSync(join(workDir, "deploy.sh"), "echo v2-CHANGED\n"); // drift
    const r = await procedureSweep({ db, cwd: workDir });
    expect(r.marked_stale).toContain(id); // valid drifting procedure still swept
    expect(r.scanned).toBe(2); // corrupt row counted in scan, not crash
  });
});

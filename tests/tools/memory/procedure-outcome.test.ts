import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { procedurePropose } from "../../../src/tools/memory/procedure-propose.js";
import { procedureOutcome } from "../../../src/tools/memory/procedure-outcome.js";
import { parseProcedure } from "../../../src/memory/procedure-content.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-proc-out-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db"), repo: "o/r" });
  const client = new OllamaClient();
  vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([0, 1, 0, 0]));
  return { db, embedder: new Embedder({ client, model: "test" }) };
}

async function makeProc(db: any, embedder: any) {
  const { id } = await procedurePropose({
    db, embedder,
    input: {
      name: "deploy sqld", trigger: "infra ECS/ALB",
      steps: ["run {deploy}"], depends_on_paths: ["infra/deploy.sh"],
      validated_at_sha: "abc", sources: [],
    },
  });
  return id;
}

async function content(db: any, id: string) {
  const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
  return parseProcedure(row.content);
}

describe("procedureOutcome", () => {
  it("promotes proposed -> validated after N=2 judge-confirmed successes", async () => {
    const { db, embedder } = await setup();
    const id = await makeProc(db, embedder);

    let r = await procedureOutcome({
      db, embedder,
      input: { procedure_id: id, outcome: "success", judge_confirmed: true,
               situation: "infra deploy", action_type: "migrate", evidence: "CI green", cycle_id: "c_1" },
    });
    expect(r.status).toBe("proposed"); // 1 success, not yet promoted
    expect((await content(db, id)).times_applied).toBe(1);

    r = await procedureOutcome({
      db, embedder,
      input: { procedure_id: id, outcome: "success", judge_confirmed: true,
               situation: "infra deploy", action_type: "migrate", evidence: "CI green", cycle_id: "c_1" },
    });
    expect(r.status).toBe("validated"); // 2 successes -> promoted
    expect((await content(db, id)).status).toBe("validated");
    expect((await content(db, id)).success_rate).toBe(1);
  });

  it("does NOT promote on unconfirmed successes (gate is judge verdicts)", async () => {
    const { db, embedder } = await setup();
    const id = await makeProc(db, embedder);
    await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: false, situation: "s", action_type: "fix", evidence: "e", cycle_id: "c_1" } });
    await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: false, situation: "s", action_type: "fix", evidence: "e", cycle_id: "c_1" } });
    expect((await content(db, id)).status).toBe("proposed");
  });

  it("every application writes an episode carrying the procedure provenance tag and cycle_id", async () => {
    const { db, embedder } = await setup();
    const id = await makeProc(db, embedder);
    await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "deploy sqld step", action_type: "migrate", evidence: "CI green", cycle_id: "c_7" } });
    const eps = await db.all<any>("SELECT * FROM memory WHERE type = 'episode'");
    expect(eps.length).toBe(1);
    // Plan 1's writeEpisode lands the singular `source` in the row's sources array as
    // ['epic:<epic_id>', 'procedure:<id>']; cycle_id is carried in the episode content.
    expect(JSON.parse(eps[0].sources)).toContain(`procedure:${id}`);
    const epContent = JSON.parse(eps[0].content);
    expect(epContent.cycle_id).toBe("c_7");
    // epic_id falls back to the procedure id when no epic is supplied
    expect(epContent.epic_id).toBe(id);
  });

  it("failure fires a failure_signature and decrements success_rate", async () => {
    const { db, embedder } = await setup();
    const id = await makeProc(db, embedder);
    await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "ok", cycle_id: "c_1" } });
    const r = await procedureOutcome({
      db, embedder,
      input: { procedure_id: id, outcome: "failure", judge_confirmed: true,
               situation: "deploy failed", action_type: "migrate", evidence: "ALB unreachable", cycle_id: "c_1" },
    });
    expect((await content(db, id)).success_rate).toBe(0.5); // 1 of 2
    const sigs = await db.all<any>("SELECT * FROM memory WHERE type = 'failure_signature'");
    expect(sigs.length).toBe(1);
    expect(r.failure_signature_id).toMatch(/^stm_/);
  });

  it("archives below floor 0.5 after >=4 applications", async () => {
    const { db, embedder } = await setup();
    const id = await makeProc(db, embedder);
    // 1 success then 3 failures -> 1/4 = 0.25 after the 4th application
    await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "ok", cycle_id: "c_1" } });
    for (let i = 0; i < 3; i++) {
      await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "failure", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "boom", cycle_id: "c_1" } });
    }
    const c = await content(db, id);
    expect(c.times_applied).toBe(4);
    expect(c.success_rate).toBeCloseTo(0.25, 5);
    expect(c.status).toBe("archived");
  });

  it("a stale procedure promotes back to validated like a proposed one", async () => {
    const { db, embedder } = await setup();
    const id = await makeProc(db, embedder);
    // force status to stale (what the sweep would do)
    const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
    const c = parseProcedure(row.content);
    await db.run("UPDATE memory SET content = ? WHERE id = ?", [JSON.stringify({ ...c, status: "stale" }), id]);
    await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "ok", cycle_id: "c_1" } });
    const r = await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "ok", cycle_id: "c_1" } });
    expect(r.status).toBe("validated");
  });

  it("a once-validated procedure that drifts to stale must re-earn a fresh N=2 (does not re-promote on a single post-stale success)", async () => {
    const { db, embedder } = await setup();
    const id = await makeProc(db, embedder);
    // Promote proposed -> validated via 2 confirmed successes, then keep applying while
    // validated so a naive counter would climb to 4. This is the case `stale` exists to
    // model: a procedure that WAS validated and accrued successes, not a fresh draft.
    for (let i = 0; i < 4; i++) {
      await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "ok", cycle_id: "c_1" } });
    }
    expect((await content(db, id)).status).toBe("validated");

    // Force validated -> stale preserving the stored row content verbatim (internal
    // bookkeeping field included), exactly as procedureSweep's validated->stale flip does.
    const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
    const stored = JSON.parse(row.content);
    await db.run("UPDATE memory SET content = ? WHERE id = ?", [JSON.stringify({ ...stored, status: "stale" }), id]);

    // First post-stale confirmed success: counter restarts from 0, so still stale (1 < N=2).
    let r = await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "ok", cycle_id: "c_1" } });
    expect(r.status).toBe("stale");
    // Second post-stale confirmed success completes the fresh N=2 -> validated.
    r = await procedureOutcome({ db, embedder, input: { procedure_id: id, outcome: "success", judge_confirmed: true, situation: "s", action_type: "migrate", evidence: "ok", cycle_id: "c_1" } });
    expect(r.status).toBe("validated");
  });
});

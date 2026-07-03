import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { procedurePropose } from "../../../src/tools/memory/procedure-propose.js";
import { procedureGrounding } from "../../../src/tools/procedures/procedure-grounding.js";
import { parseProcedure } from "../../../src/memory/procedure-content.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-proc-ground-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db"), repo: "o/r" });
  const client = new OllamaClient();
  // deterministic embed: same vector so cosine ranks all equally; FTS distinguishes by trigger words
  vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([0, 1, 0, 0]));
  return { db, embedder: new Embedder({ client, model: "test" }) };
}

async function setStatus(db: any, id: string, status: string) {
  const row = await db.get<any>("SELECT content FROM memory WHERE id = ?", [id]);
  await db.run("UPDATE memory SET content = ? WHERE id = ?",
    [JSON.stringify({ ...parseProcedure(row.content), status }), id]);
  // keep FTS in sync so trigger words still match
  await db.run("DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)", [id]);
  const c = { ...parseProcedure(row.content), status };
  await db.run("INSERT INTO memory_fts(rowid, content) VALUES ((SELECT rowid FROM memory WHERE id = ?), ?)",
    [id, JSON.stringify(c)]);
}

describe("procedureGrounding", () => {
  it("labels validated procedures follow-this and proposed/stale draft-verify; excludes archived", async () => {
    const { db, embedder } = await setup();
    const v = await procedurePropose({ db, embedder, input: { name: "deploy infra", trigger: "infra deploy ECS ALB", steps: ["x"], depends_on_paths: [], validated_at_sha: "a", sources: [] } });
    const p = await procedurePropose({ db, embedder, input: { name: "deploy infra draft", trigger: "infra deploy ECS ALB", steps: ["x"], depends_on_paths: [], validated_at_sha: "a", sources: [] } });
    const s = await procedurePropose({ db, embedder, input: { name: "deploy infra old", trigger: "infra deploy ECS ALB", steps: ["x"], depends_on_paths: [], validated_at_sha: "a", sources: [] } });
    const a = await procedurePropose({ db, embedder, input: { name: "deploy infra dead", trigger: "infra deploy ECS ALB", steps: ["x"], depends_on_paths: [], validated_at_sha: "a", sources: [] } });
    await setStatus(db, v.id, "validated");
    await setStatus(db, s.id, "stale");
    await setStatus(db, a.id, "archived");

    const r = await procedureGrounding({
      db, embedder,
      input: { trigger: "infra deploy ECS ALB", action_type: "migrate" },
    });

    const byId = new Map(r.procedures.map((x) => [x.id, x]));
    expect(byId.get(v.id)?.injection).toBe("follow-this");
    expect(byId.get(p.id)?.injection).toBe("draft-verify");
    expect(byId.get(s.id)?.injection).toBe("draft-verify");
    expect(byId.has(a.id)).toBe(false); // archived excluded
  });

  it("echoes the chosen action_type on the brief", async () => {
    const { db, embedder } = await setup();
    await procedurePropose({ db, embedder, input: { name: "n", trigger: "infra deploy", steps: ["x"], depends_on_paths: [], validated_at_sha: "a", sources: [] } });
    const r = await procedureGrounding({ db, embedder, input: { trigger: "infra deploy", action_type: "migrate" } });
    expect(r.action_type).toBe("migrate");
  });

  it("attributes its recall trace to the act caller, not unknown", async () => {
    // Act-time grounding must label its recall_trace 'act' so per-caller observability
    // (Plan 0 — `backant memory why` labels these [act]) can attribute procedure recalls.
    // Mirrors the deliberate fix in decision-grounding (commit 8354937).
    const { db, embedder } = await setup();
    await procedurePropose({ db, embedder, input: { name: "n", trigger: "infra deploy", steps: ["x"], depends_on_paths: [], validated_at_sha: "a", sources: [] } });
    await procedureGrounding({ db, embedder, input: { trigger: "infra deploy", action_type: "migrate" } });
    const traces = await db.all<{ caller: string }>("SELECT caller FROM recall_trace ORDER BY id");
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((r) => r.caller === "act")).toBe(true);
  });
});

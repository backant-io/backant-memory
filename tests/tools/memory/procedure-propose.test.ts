import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../../../src/memory/libsql-db.js";
import { procedurePropose } from "../../../src/tools/memory/procedure-propose.js";
import { parseProcedure, embeddingTextFor } from "../../../src/memory/procedure-content.js";
import { Embedder } from "../../../src/ollama/embeddings.js";
import { OllamaClient } from "../../../src/ollama/client.js";

let tempDir: string;
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-proc-prop-"));
  const db = await openMemoryDb({ localPath: join(tempDir, ".index.db"), repo: "o/r" });
  const client = new OllamaClient();
  const spy = vi.spyOn(client, "embed").mockResolvedValue(new Float32Array([0, 1, 0, 0]));
  return { db, embedder: new Embedder({ client, model: "test" }), spy };
}

describe("procedurePropose", () => {
  it("writes a proposed ltm procedure row with sequenced id", async () => {
    const { db, embedder } = await setup();
    const r = await procedurePropose({
      db, embedder,
      input: {
        name: "deploy sqld infra change",
        trigger: "when an infra/ task touches ECS or ALB",
        steps: ["run {deploy_script}", "verify {health_check}"],
        depends_on_paths: ["infra/deploy.sh"],
        validated_at_sha: "20b4375",
        sources: ["pr:#412"],
      },
    });
    expect(r.id).toMatch(/^ltm_procedure_\d+$/);
    const row = await db.get<any>("SELECT * FROM memory WHERE id = ?", [r.id]);
    expect(row.tier).toBe("ltm");
    expect(row.type).toBe("procedure");
    expect(row.repo).toBe("o/r");
    expect(JSON.parse(row.sources)).toEqual(["pr:#412"]);
    const c = parseProcedure(row.content);
    expect(c.status).toBe("proposed");
    expect(c.times_applied).toBe(0);
    expect(c.success_rate).toBeNull();
    expect(c.depends_on_paths).toEqual(["infra/deploy.sh"]);
  });

  it("generates sequential ltm procedure ids", async () => {
    const { db, embedder } = await setup();
    const mk = (n: string) => ({
      name: n, trigger: "t", steps: ["s"],
      depends_on_paths: [], validated_at_sha: "abc", sources: [],
    });
    const a = await procedurePropose({ db, embedder, input: mk("first") });
    const b = await procedurePropose({ db, embedder, input: mk("second") });

    expect(a.id).toBe("ltm_procedure_001");
    expect(b.id).toBe("ltm_procedure_002");
    expect(await db.get<any>("SELECT id FROM memory WHERE id = ?", [a.id])).toBeTruthy();
    expect(await db.get<any>("SELECT id FROM memory WHERE id = ?", [b.id])).toBeTruthy();
  });

  it("embeds over name + trigger only (not steps)", async () => {
    const { db, embedder, spy } = await setup();
    await procedurePropose({
      db, embedder,
      input: {
        name: "N", trigger: "T", steps: ["secret-step-text"],
        depends_on_paths: [], validated_at_sha: "abc", sources: [],
      },
    });
    // Embedder.embed(text) calls client.embed({ model, input: text }); assert on the
    // object shape the client receives (sibling convention: write-episode.test.ts:61).
    expect(spy).toHaveBeenCalledWith({ model: "test", input: embeddingTextFor({ name: "N", trigger: "T" }) });
    expect(spy.mock.calls[0][0].input).not.toContain("secret-step-text");
  });

  it("is FTS-searchable by name", async () => {
    const { db, embedder } = await setup();
    await procedurePropose({
      db, embedder,
      input: {
        name: "rotate database credentials", trigger: "on cred expiry",
        steps: ["x"], depends_on_paths: [], validated_at_sha: "abc", sources: [],
      },
    });
    const hit = await db.get<{ rowid: number }>(
      "SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'credentials'"
    );
    expect(hit).toBeTruthy();
  });
});

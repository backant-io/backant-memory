import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryServer } from "../../src/server.js";
import { startHttpDaemon } from "../../src/daemon/http.js";
import type { Embedder } from "../../src/ollama/embeddings.js";

let base: string, close: () => Promise<void>, kairosHome: string;
const TOKEN = "a".repeat(64);

// Deterministic fake embedder: same vector for every text, so /digest recall runs
// entirely offline (no live Ollama, no ~11s timeout) while still exercising the
// real recall SQL path against the per-request repo-scoped store.
const fakeEmbedder = {
  embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
} as unknown as Embedder;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bam-http-"));
  kairosHome = mkdtempSync(join(tmpdir(), "bam-http-home-"));
  const server = await buildMemoryServer({ workspaceCwd: dir, memoryDbPath: join(dir, "m.db") });
  // /digest reads opts.server.embedder — swap in the offline fake.
  server.embedder = fakeEmbedder;
  const d = await startHttpDaemon({
    server, port: 0, token: TOKEN, version: "0.1.0-test",
    embeddingModel: "test-model", kairosHome,
  });
  base = `http://127.0.0.1:${d.port}`;
  close = d.close;
});
afterAll(async () => { await close(); });

describe("http daemon", () => {
  it("healthz is open and reports shape", async () => {
    const r = await fetch(`${base}/healthz`);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(typeof j.pid).toBe("number");
    expect(j.version).toBe("0.1.0-test");
  });

  it("rejects /mcp without bearer token", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  it("rejects /digest without a bearer token (it exposes memory content)", async () => {
    const r = await fetch(`${base}/digest?cwd=${encodeURIComponent(process.cwd())}`);
    expect(r.status).toBe(401);
  });

  it("serves /digest with token, repo-scoped per request — empty git-less store → ''", async () => {
    // A git-less temp dir resolves to the local-only namespace; its store (under
    // the injected temp kairosHome) is empty, so the digest is "".
    const gitless = mkdtempSync(join(tmpdir(), "bam-digest-cwd-"));
    const r = await fetch(`${base}/digest?cwd=${encodeURIComponent(gitless)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.digest).toBe("");
  });

  it("rejects /recall without a bearer token", async () => {
    const r = await fetch(`${base}/recall?cwd=${encodeURIComponent(process.cwd())}&cue=x`);
    expect(r.status).toBe(401);
  });

  it("serves /recall with token: repo-scoped hits for a cue, hits carry timestamps", async () => {
    // WHY: this is the warm path the UserPromptSubmit hook depends on; the hook
    // renders ages from last_reinforced, so the field must survive the wire.
    const gitless = mkdtempSync(join(tmpdir(), "bam-recall-cwd-"));
    const { buildMemoryContext } = await import("../../src/memory/context.js");
    const { writeStm } = await import("../../src/tools/memory/write-stm.js");
    const ctx = await buildMemoryContext({ workspaceCwd: gitless, embeddingModel: "test-model", forceLocal: true, kairosHome });
    await writeStm({ db: ctx.db, embedder: fakeEmbedder, input: { type: "observation", content: "use pnpm not npm here", sources: ["t"] } });
    await ctx.db.close();
    const r = await fetch(`${base}/recall?cwd=${encodeURIComponent(gitless)}&cue=${encodeURIComponent("pnpm npm")}&k=3`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.hits)).toBe(true);
    expect(j.hits.length).toBe(1);
    expect(j.hits[0].content).toBe("use pnpm not npm here");
    expect(typeof j.hits[0].last_reinforced).toBe("string");
    expect(typeof j.hits[0].created).toBe("string");
  });

  it("serves MCP initialize with token", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("backant-memory");
  });

  it("unknown path is 404", async () => {
    const r = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(404);
  });
});

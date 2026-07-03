import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryServer } from "../../src/server.js";
import { startHttpDaemon } from "../../src/daemon/http.js";

let base: string, close: () => Promise<void>;
const TOKEN = "a".repeat(64);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bam-http-"));
  const server = await buildMemoryServer({ workspaceCwd: dir, memoryDbPath: join(dir, "m.db") });
  const d = await startHttpDaemon({ server, port: 0, token: TOKEN, version: "0.1.0-test" });
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

  // Real recall path: /digest embeds one cue per fixed cue. Generous timeout
  // covers a cold local Ollama load; with no Ollama embeds throw fast (instant).
  it("serves /digest without a bearer token (localhost trust, same as /healthz)", async () => {
    const r = await fetch(`${base}/digest?cwd=${encodeURIComponent(process.cwd())}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(typeof j.digest).toBe("string");
  }, 30_000);

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

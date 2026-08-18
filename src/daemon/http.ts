import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isMemoryBackendReachable } from "../ollama/health.js";
import { buildMemoryContext } from "../memory/context.js";
import { readOrigin, deriveIdentity } from "../memory/repo-identity.js";
import type { MemoryServer } from "../server.js";
import type { MemoryDb } from "../memory/libsql-db.js";

interface DaemonOptions {
  server: MemoryServer;
  port: number;
  token: string;
  version: string;
  /** Embedding model the per-request /digest store must be opened with. */
  embeddingModel: string;
  /** kairos data home for /digest stores; defaults to ~/.claude/kairos (tests inject). */
  kairosHome?: string;
}

export async function startHttpDaemon(opts: DaemonOptions) {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Per-request /digest opens the repo-scoped store for the caller's cwd, cached
  // by repo key so a repeated session-start on the same repo reuses the handle.
  const digestDbCache = new Map<string, MemoryDb>();

  const authorized = (req: IncomingMessage) =>
    req.headers.authorization === `Bearer ${opts.token}`;

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/healthz") {
        const ollama = await isMemoryBackendReachable().catch(() => false);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, pid: process.pid, version: opts.version, ollama, db: true }));
        return;
      }
      if (!authorized(req)) { res.writeHead(401).end(); return; }

      // Per-cwd store resolution shared by /digest and /recall: both sit BELOW
      // the auth gate (bearer required) because they expose memory content, and
      // both open the store repo-scoped to ?cwd — one daemon, many repos.
      const openStoreForCwd = async (cwd: string): Promise<MemoryDb> => {
        const origin = readOrigin(cwd);
        const key = deriveIdentity(origin).repoKey;
        let db = digestDbCache.get(key);
        if (!db) {
          const ctx = await buildMemoryContext({
            workspaceCwd: cwd,
            originUrl: origin,
            embeddingModel: opts.embeddingModel,
            forceLocal: true,
            kairosHome: opts.kairosHome,
          });
          db = ctx.db;
          digestDbCache.set(key, db);
        }
        return db;
      };

      // /digest returns the SessionStart digest for the caller's repo. Any
      // failure returns {digest:""} so session start is never blocked.
      if (url.pathname === "/digest" && req.method === "GET") {
        let digest = "";
        try {
          const cwd = url.searchParams.get("cwd") ?? "/";
          const db = await openStoreForCwd(cwd);
          const { buildDigestForCwd } = await import("../hooks/session-start-recall.js");
          digest = await buildDigestForCwd(cwd, { db, embedder: opts.server.embedder });
        } catch {
          /* digest must never break session start */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ digest }));
        return;
      }

      // /recall is the warm path for the UserPromptSubmit hook: one cue, top-k
      // hits for the caller's repo. Any failure returns {hits:[]} — a prompt is
      // never held up by memory.
      if (url.pathname === "/recall" && req.method === "GET") {
        let hits: unknown[] = [];
        let repo = "";
        try {
          const cwd = url.searchParams.get("cwd") ?? "/";
          const cue = (url.searchParams.get("cue") ?? "").trim();
          const k = Math.min(20, Math.max(1, Number(url.searchParams.get("k") ?? 4) || 4));
          const caller = url.searchParams.get("caller") ?? "prompt";
          if (cue) {
            const db = await openStoreForCwd(cwd);
            repo = db.repo;
            const { recall } = await import("../tools/memory/recall.js");
            hits = await recall({ db, embedder: opts.server.embedder, caller, input: { cue, k } });
          }
        } catch {
          /* recall must never break a prompt */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ repo, hits }));
        return;
      }

      if (url.pathname === "/mcp") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { transports.set(id, transport!); },
          });
          transport.onclose = () => {
            if (transport!.sessionId) transports.delete(transport!.sessionId);
          };
          await opts.server.createMcpServer().connect(transport);
        }
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, "127.0.0.1", resolve);   // localhost bind ONLY (spec D10)
  });
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : opts.port;

  return {
    port: boundPort,
    close: () => new Promise<void>((resolve) => {
      for (const t of transports.values()) t.close?.();
      for (const db of digestDbCache.values()) void db.close();
      httpServer.close(() => resolve());
    }),
  };
}

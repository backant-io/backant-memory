import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isMemoryBackendReachable } from "../ollama/health.js";
import type { MemoryServer } from "../server.js";

interface DaemonOptions { server: MemoryServer; port: number; token: string; version: string }

export async function startHttpDaemon(opts: DaemonOptions) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

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

      if (url.pathname === "/digest" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd") ?? process.cwd();
        const { buildDigestForCwd } = await import("../hooks/session-start-recall.js");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ digest: await buildDigestForCwd(cwd, opts.server) }));
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
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
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
      httpServer.close(() => resolve());
    }),
  };
}

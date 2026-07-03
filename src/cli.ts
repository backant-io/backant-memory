import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolvePaths } from "./paths.js";
import { buildMemoryServer } from "./server.js";
import { buildMemoryContext } from "./memory/context.js";
import { startHttpDaemon } from "./daemon/http.js";
import { startSupervisor, siblingIsHealthy } from "./daemon/supervisor.js";
import { serviceStatus } from "./daemon/launchd.js";
import { runInstall, runUninstall, defaultBinPath } from "./install/installer.js";
import { ensureToken } from "./daemon/token.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const program = new Command().name("backant-memory").version(pkg.version);

program.command("serve")
  .option("--http", "serve streamable HTTP (used by launchd)")
  .option("--stdio", "serve stdio (default)")
  .option("--port <n>", "http port")
  .action(async (opts) => {
    const paths = resolvePaths();
    const port = opts.port ? Number(opts.port) : paths.port;
    // Direct DB override wins on both branches (test/pinned-store escape hatch).
    const dbOverride = process.env.BACKANT_MEMORY_DB;
    if (opts.http) {
      // HTTP daemon serves ONE global store (repo="") — sessions carry no cwd, so
      // it cannot repo-scope per request. Documented partition for other agents;
      // per-request /digest scoping (below) is what Claude sessions actually use.
      const server = await buildMemoryServer({
        workspaceCwd: process.cwd(),
        ollamaUrl: paths.ollamaUrl,
        embeddingModel: paths.embeddingModel,
        ...(dbOverride ? { memoryDbPath: dbOverride } : {}),
      });
      if (await siblingIsHealthy(port)) {
        process.stderr.write("healthy sibling already on port; exiting\n");
        process.exit(0);
      }
      const token = ensureToken(paths.tokenPath);
      await startHttpDaemon({ server, port, token, version: pkg.version, embeddingModel: paths.embeddingModel });
      startSupervisor();
      process.stderr.write(`backant-memory ${pkg.version} listening on 127.0.0.1:${port}\n`);
    } else {
      // stdio for Claude Code: resolve the repo-scoped store for THIS session's
      // cwd (isolation + kairos sharing), local replica only per the local-first
      // rule (remote sync is a follow-up). BACKANT_MEMORY_DB pins a fixed store.
      const server = dbOverride
        ? await buildMemoryServer({
            workspaceCwd: process.cwd(),
            ollamaUrl: paths.ollamaUrl,
            embeddingModel: paths.embeddingModel,
            memoryDbPath: dbOverride,
          })
        : await (async () => {
            const ctx = await buildMemoryContext({
              workspaceCwd: process.cwd(),
              embeddingModel: paths.embeddingModel,
              forceLocal: true,
            });
            return buildMemoryServer({
              workspaceCwd: process.cwd(),
              ollamaUrl: paths.ollamaUrl,
              embeddingModel: paths.embeddingModel,
              db: ctx.db,
              repo: ctx.repo,
            });
          })();
      // stdio transport holds the event loop open; do NOT exit after this.
      await server.startStdio();
    }
  });

program.command("install")
  .option("--no-hook")
  .option("--port <n>")
  .option("--refresh-service")
  .action(async (opts) => {
    const r = await runInstall({ noHook: !opts.hook, port: opts.port ? Number(opts.port) : undefined });
    console.log(`installed: MCP at ${r.url}; run 'backant-memory status' to verify`);
  });

program.command("uninstall").action(async () => {
  await runUninstall();
  console.log("uninstalled");
});

program.command("status").action(async () => {
  const paths = resolvePaths();
  const svc = await serviceStatus();
  const health = await siblingIsHealthy(paths.port);
  console.log(`service: ${svc}; http: ${health ? "healthy" : "unreachable"} (127.0.0.1:${paths.port})`);
  process.exit(svc === "running" && health ? 0 : 1);
});

program.command("print-config")
  .option("--client <c>", "claude|cursor|generic", "generic")
  .action((opts) => {
    const paths = resolvePaths();
    const stdio = { mcpServers: { "backant-memory": {
      type: "stdio", command: defaultBinPath(), args: ["serve"] } } };
    const http = { mcpServers: { "backant-memory": {
      type: "http", url: `http://127.0.0.1:${paths.port}/mcp`,
      headers: { Authorization: `Bearer ${ensureToken(paths.tokenPath)}` } } } };
    if (opts.client === "claude") {
      console.log(JSON.stringify(stdio, null, 2));
      return;
    }
    // Default (generic / any non-claude client): both — stdio is recommended for
    // Claude Code (per-session, repo-scoped); http+token is for other agents.
    console.log("# Claude Code (recommended — stdio, per-session repo-scoped):");
    console.log(JSON.stringify(stdio, null, 2));
    console.log("# Other agents (http + bearer token, global store):");
    console.log(JSON.stringify(http, null, 2));
  });

program.command("doctor")
  .option("--verify-restart", "kill the daemon and verify launchd relaunches it")
  .action(async (opts) => {
    const { runDoctor } = await import("./doctor.js");
    process.exit(await runDoctor(opts));
  });

program.parseAsync().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});

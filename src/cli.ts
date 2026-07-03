import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolvePaths } from "./paths.js";
import { buildMemoryServer } from "./server.js";
import { startHttpDaemon } from "./daemon/http.js";
import { startSupervisor, siblingIsHealthy } from "./daemon/supervisor.js";
import { serviceStatus } from "./daemon/launchd.js";
import { runInstall, runUninstall } from "./install/installer.js";
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
    const server = await buildMemoryServer({
      workspaceCwd: process.cwd(),
      ollamaUrl: paths.ollamaUrl,
      embeddingModel: paths.embeddingModel,
    });
    if (opts.http) {
      if (await siblingIsHealthy(port)) {
        process.stderr.write("healthy sibling already on port; exiting\n");
        process.exit(0);
      }
      const token = ensureToken(paths.tokenPath);
      await startHttpDaemon({ server, port, token, version: pkg.version });
      startSupervisor();
      process.stderr.write(`backant-memory ${pkg.version} listening on 127.0.0.1:${port}\n`);
    } else {
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
  .action(() => {
    const paths = resolvePaths();
    const token = ensureToken(paths.tokenPath);
    console.log(JSON.stringify({ mcpServers: { "backant-memory": {
      type: "http", url: `http://127.0.0.1:${paths.port}/mcp`,
      headers: { Authorization: `Bearer ${token}` } } } }, null, 2));
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

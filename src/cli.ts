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
  .option("--tools <profile>", "tool surface: 'core' (9 consolidated tools; stdio default) or 'full' (core + every legacy name; http default). Env: BACKANT_MEMORY_TOOLS")
  .action(async (opts) => {
    const paths = resolvePaths();
    const port = opts.port ? Number(opts.port) : paths.port;
    // Tool surface: stdio (Claude Code) gets the consolidated core set; the HTTP
    // daemon keeps every legacy name for other agents. --tools / env override.
    const profileArg = (opts.tools ?? process.env.BACKANT_MEMORY_TOOLS) as string | undefined;
    if (profileArg && profileArg !== "core" && profileArg !== "full") {
      throw new Error(`--tools must be 'core' or 'full' (got ${profileArg})`);
    }
    const toolProfile = (profileArg as "core" | "full" | undefined) ?? (opts.http ? "full" : "core");
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
        toolProfile,
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
            toolProfile,
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
              toolProfile,
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
    // stdio = core tool profile (9 consolidated tools); alwaysLoad keeps them out
    // of Claude Code's tool-search deferral. Add `"--tools","full"` to args for
    // every legacy tool name.
    const stdio = { mcpServers: { "backant-memory": {
      type: "stdio", command: defaultBinPath(), args: ["serve"], alwaysLoad: true } } };
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
    console.log("# Other agents (http + bearer token, global store, full tool profile incl. legacy names):");
    console.log(JSON.stringify(http, null, 2));
  });

program.command("doctor")
  .option("--verify-restart", "kill the daemon and verify launchd relaunches it")
  .action(async (opts) => {
    const { runDoctor } = await import("./doctor.js");
    process.exit(await runDoctor(opts));
  });

program.command("usage")
  .description("measure memory adoption from Claude Code transcripts (~/.claude/projects): sessions by entrypoint, hook/digest presence, memory calls per 1k turns")
  .option("--days <n>", "look back this many days", "30")
  .option("--min-turns <n>", "ignore sessions with fewer assistant turns", "10")
  .option("--projects-dir <path>", "override ~/.claude/projects")
  .option("--json", "emit the report as JSON")
  .action(async (opts) => {
    const { scanTranscripts, aggregateUsage, renderUsageReport } = await import("./usage.js");
    const days = Number(opts.days) || 30;
    const sessions = await scanTranscripts({ projectsDir: opts.projectsDir, sinceMs: Date.now() - days * 86_400_000 });
    const report = aggregateUsage(sessions, { minTurns: Number(opts.minTurns) || 10 });
    console.log(opts.json ? JSON.stringify(report, null, 2) : renderUsageReport(report, { days }));
  });

// ---- the four memory verbs (spec: employees carry the CLI, never MCP) ----
// Each opens the SAME repo-scoped store `serve` opens for stdio, so an effect
// written here is found by the MCP tools that store serves, and vice versa.
// Errors (store unreachable, bad enum, ltm without a reason) fall through to the
// handler at the bottom of this file: reason on stderr, non-zero exit.

program.command("recall")
  .description("recall memories for a cue; one JSON object per line with id, tier, type, age and content")
  .requiredOption("--cue <text>", "what you are about to re-derive")
  .option("--k <n>", "how many hits", "10")
  .option("--tier <tier>", "any|stm|ltm", "any")
  .option("--cross-repo", "recall across every repo in the namespace")
  .action(async (opts) => {
    const { openCliStore, runRecall } = await import("./memory-verbs.js");
    const store = await openCliStore();
    const lines = await runRecall(store, {
      cue: opts.cue,
      k: Number(opts.k) || 10,
      tier: opts.tier,
      crossRepo: Boolean(opts.crossRepo),
    });
    for (const line of lines) console.log(line);
  });

program.command("reinforce")
  .description("mark a recalled entry as having proved right")
  .requiredOption("--id <id>", "the id a recall printed")
  .option("--reason <text>", "citation category: act-cite|dream-cite raise verdict_boost, anything else only touches last_reinforced", "act-cite")
  .option("--factor <n>", "weight multiplier, capped at 1.0", "1.2")
  .action(async (opts) => {
    const { openCliStore, runReinforce } = await import("./memory-verbs.js");
    const store = await openCliStore();
    console.log(JSON.stringify(await runReinforce(store, {
      id: opts.id,
      reason: opts.reason,
      factor: Number(opts.factor) || 1.2,
    })));
  });

program.command("write")
  .description("write one memory; ltm requires --reason")
  .requiredOption("--tier <tier>", "stm|ltm")
  .requiredOption("--type <type>", "observation|lesson|principle|architecture|...")
  .requiredOption("--content <text>", "what is worth keeping")
  .requiredOption("--source <path_or_url>", "where it came from")
  .option("--reason <text>", "why this is durable, verified knowledge (required for ltm)")
  .action(async (opts) => {
    const { openCliStore, runWrite } = await import("./memory-verbs.js");
    const store = await openCliStore();
    console.log(JSON.stringify(await runWrite(store, opts)));
  });

program.command("episode")
  .description("record an attempt whose result surprised you")
  .requiredOption("--situation <text>", "what you were facing")
  .requiredOption("--action <text>", "what you did")
  .requiredOption("--expected <e>", "success|failure")
  .requiredOption("--outcome <o>", "success|failure|partial")
  .option("--evidence <text>", "what shows the outcome")
  .option("--action-type <t>", "fix|merge|implement|review-feedback|migrate|investigate|other", "other")
  .option("--epic-id <id>", "group this episode under an epic", "adhoc")
  .action(async (opts) => {
    const { openCliStore, runEpisode } = await import("./memory-verbs.js");
    const store = await openCliStore();
    console.log(JSON.stringify(await runEpisode(store, {
      situation: opts.situation,
      action: opts.action,
      expected: opts.expected,
      outcome: opts.outcome,
      evidence: opts.evidence,
      actionType: opts.actionType,
      epicId: opts.epicId,
    })));
  });

program.parseAsync().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});

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

// ---- the four memory verbs -------------------------------------------------
// One process, one command, one JSON line back (spec 2026-09-01 §12). Every verb
// opens the same repo-scoped store `serve --stdio` opens for this cwd, runs the
// same operation the matching MCP tool runs, prints its result and closes. The
// implementations live in ./verbs.js so the shell path and the MCP path cannot
// drift into two behaviours with one name.
async function withSession<T>(run: (s: import("./verbs.js").VerbSession) => Promise<T>): Promise<T> {
  const { openSession } = await import("./verbs.js");
  let session;
  try {
    session = await openSession();
  } catch (err) {
    // The store is the precondition for all four verbs; say which one failed and
    // where, rather than letting a libsql/provisioning message surface bare.
    throw new Error(`memory store unreachable: ${(err as Error).message}`);
  }
  try {
    return await run(session);
  } finally {
    await session.close().catch(() => {});
  }
}

/** Repeatable option collector: `--source a --source b` → ["a","b"]. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program.command("recall")
  .description("recall stored knowledge for this repo; prints one JSON object per hit (id, tier, type, age, content)")
  .requiredOption("--cue <text>", "short cue, e.g. 'auth token refresh bug'")
  .option("--k <n>", "how many hits to return", "10")
  .action(async (opts) => {
    const k = Number(opts.k);
    if (!Number.isFinite(k) || k < 1) throw new Error(`--k must be a positive number (got ${JSON.stringify(opts.k)})`);
    const lines = await withSession(async (s) => {
      const { runRecall } = await import("./verbs.js");
      return runRecall(s, { cue: opts.cue, k });
    });
    // One JSON object per line: a shell can pipe it to jq, head or grep without
    // parsing an array that only ends when the process does.
    for (const line of lines) console.log(JSON.stringify(line));
  });

program.command("reinforce")
  .description("a recalled entry proved right: bump its weight and citation count")
  .requiredOption("--id <id>", "the id printed by recall")
  .option("--reason <text>", "why it proved right (default 'act-cite', the citation reason recall ranks on)")
  .action(async (opts) => {
    const r = await withSession(async (s) => {
      const { runReinforce } = await import("./verbs.js");
      return runReinforce(s, { id: opts.id, reason: opts.reason });
    });
    console.log(JSON.stringify(r));
  });

program.command("write")
  .description("write a memory for this repo; ltm is verified, durable knowledge and requires --reason")
  .requiredOption("--tier <tier>", "stm|ltm")
  .requiredOption("--type <type>", "observation|lesson|architecture|principle|gotcha|convention|…")
  .requiredOption("--content <text>", "what you learned, in words that are not derivable from the code")
  // Not `requiredOption`: commander only enforces that on an option with no
  // default, and a repeatable collector needs [] to collect into. runWrite makes
  // the requirement, and says what a source is when it is missing.
  .option("--source <path>", "REQUIRED. where it came from: path, URL, PR id or command (repeatable)", collect, [])
  .option("--reason <text>", "required for --tier ltm: why this is durable and verified")
  .action(async (opts) => {
    const r = await withSession(async (s) => {
      const { runWrite } = await import("./verbs.js");
      return runWrite(s, {
        tier: opts.tier, type: opts.type, content: opts.content,
        sources: opts.source, reason: opts.reason,
      });
    });
    console.log(JSON.stringify(r));
  });

program.command("episode")
  .description("record an attempt whose result you want remembered; weight is surprise-scaled (mismatch = 2x)")
  .requiredOption("--situation <text>", "what the situation was")
  .requiredOption("--action <text>", "what you did")
  .requiredOption("--expected <outcome>", "success|failure — what you expected BEFORE you knew")
  .requiredOption("--outcome <outcome>", "success|failure|partial — what actually happened")
  .option("--evidence <text>", "what shows it: command output, test name, link")
  .option("--action-type <type>", "fix|merge|implement|review-feedback|migrate|investigate|other", "other")
  .action(async (opts) => {
    const r = await withSession(async (s) => {
      const { runEpisode } = await import("./verbs.js");
      return runEpisode(s, {
        situation: opts.situation, action: opts.action,
        expected: opts.expected, outcome: opts.outcome,
        evidence: opts.evidence, actionType: opts.actionType,
      });
    });
    console.log(JSON.stringify(r));
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

program.parseAsync().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});

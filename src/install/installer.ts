import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { ensureToken } from "../daemon/token.js";
import { installService, uninstallService, type ExecFn } from "../daemon/launchd.js";
import { registerMcpServer, unregisterMcpServer } from "./mcp-registration.js";
import { upsertManagedBlock, removeManagedBlock } from "./claude-md.js";
import { registerHook, unregisterHook } from "./hook-registration.js";
import { installSkill } from "./skill-install.js";

export interface InstallOptions {
  home?: string;
  claudeDir?: string;
  claudeJsonPath?: string;
  launchAgentsDir?: string;
  logDir?: string;
  assetDir?: string;
  cliPath?: string;
  binPath?: string;
  port?: number;
  noHook?: boolean;
  exec?: ExecFn;
}
export interface InstallReport {
  token: string;
  port: number;
  url: string;
}

// In production every tsup entry lives in dist/ and inlines this module
// (splitting:false), so bundleDir === <pkgroot>/dist regardless of entry
// (cli.js OR postinstall.js). Never use process.argv[1]: via the global bin
// it is the bin shim (or npm symlink), and in postinstall it is postinstall.js.
// In dev/vitest bundleDir is src/install — fine, tests inject all paths.
const bundleDir = dirname(fileURLToPath(import.meta.url));
const defaultAssetDir = () => join(bundleDir, "../assets");
const defaultHookPath = () => join(bundleDir, "hooks/session-start-recall.js");
const defaultPromptRecallHookPath = () => join(bundleDir, "hooks/prompt-recall.js");
const defaultSessionSummaryHookPath = () => join(bundleDir, "hooks/session-summary.js");
/** SessionEnd's default hook budget is 1.5s total; the summary hook hands off to
 *  a detached worker immediately, but give it headroom to spawn. Seconds. */
const SESSION_SUMMARY_HOOK_TIMEOUT_S = 20;
export const defaultCliPath = () => join(bundleDir, "cli.js");
// The executable stdio shim (#!/usr/bin/env node → dist/cli.js). Absolute and
// upgrade-stable: Claude Code spawns it directly as `<binPath> serve`.
export const defaultBinPath = () => join(bundleDir, "../bin/backant-memory.js");

export async function runInstall(o: InstallOptions = {}): Promise<InstallReport> {
  const home = o.home ?? join(homedir(), ".claude/kairos");
  const claudeDir = o.claudeDir ?? join(homedir(), ".claude");
  const claudeJsonPath = o.claudeJsonPath ?? join(homedir(), ".claude.json");
  const assetDir = o.assetDir ?? defaultAssetDir();
  const port = o.port ?? 41414;
  const url = `http://127.0.0.1:${port}/mcp`;
  const binPath = o.binPath ?? defaultBinPath();

  const token = ensureToken(join(home, "memory", ".backant-memory-token"));
  await installService({
    exec: o.exec,
    port,
    launchAgentsDir: o.launchAgentsDir,
    logDir: o.logDir,
    cliPath: o.cliPath ?? defaultCliPath(),
  });
  // Claude Code is registered over STDIO: each session spawns `backant-memory
  // serve`, which resolves the repo-scoped store for its own cwd (isolation +
  // kairos sharing). The launchd daemon stays up as the Ollama supervisor and
  // authenticated /digest + HTTP /mcp surface for other agents.
  // alwaysLoad: with MCP tool search on (the default), a server's tools are
  // deferred behind ToolSearch unless it opts out. Every session that used
  // memory in the transcript audit had to ToolSearch for it first — pin it.
  registerMcpServer({ claudeJsonPath, entry: { type: "stdio", command: binPath, args: ["serve"], alwaysLoad: true } });
  mkdirSync(claudeDir, { recursive: true });
  upsertManagedBlock(
    join(claudeDir, "CLAUDE.md"),
    readFileSync(join(assetDir, "claude-md-section.md"), "utf8").trim()
  );
  installSkill(join(claudeDir, "skills"), assetDir);
  if (!o.noHook) {
    const settings = join(claudeDir, "settings.json");
    registerHook(settings, `${process.execPath} ${defaultHookPath()}`);
    // Ambient recall: every prompt is a cue (no model judgment needed).
    registerHook(settings, `${process.execPath} ${defaultPromptRecallHookPath()}`, { event: "UserPromptSubmit" });
    // Close the write side: a deterministic session summary at compaction and exit.
    registerHook(settings, `${process.execPath} ${defaultSessionSummaryHookPath()}`, { event: "PreCompact", timeout: SESSION_SUMMARY_HOOK_TIMEOUT_S });
    registerHook(settings, `${process.execPath} ${defaultSessionSummaryHookPath()}`, { event: "SessionEnd", timeout: SESSION_SUMMARY_HOOK_TIMEOUT_S });
  }
  return { token, port, url };
}

export async function runUninstall(o: InstallOptions = {}): Promise<void> {
  const claudeDir = o.claudeDir ?? join(homedir(), ".claude");
  const claudeJsonPath = o.claudeJsonPath ?? join(homedir(), ".claude.json");
  await uninstallService({ exec: o.exec, launchAgentsDir: o.launchAgentsDir });
  unregisterMcpServer({ claudeJsonPath });
  removeManagedBlock(join(claudeDir, "CLAUDE.md"));
  unregisterHook(join(claudeDir, "settings.json"), "session-start-recall");
  unregisterHook(join(claudeDir, "settings.json"), "hooks/prompt-recall");
  unregisterHook(join(claudeDir, "settings.json"), "hooks/session-summary");
  // skill dir left in place on purpose: harmless, and removal risks deleting user edits
}

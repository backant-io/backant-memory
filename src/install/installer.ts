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
  registerMcpServer({ claudeJsonPath, entry: { type: "stdio", command: binPath, args: ["serve"] } });
  mkdirSync(claudeDir, { recursive: true });
  upsertManagedBlock(
    join(claudeDir, "CLAUDE.md"),
    readFileSync(join(assetDir, "claude-md-section.md"), "utf8").trim()
  );
  installSkill(join(claudeDir, "skills"), assetDir);
  if (!o.noHook) {
    registerHook(join(claudeDir, "settings.json"), `${process.execPath} ${defaultHookPath()}`);
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
  // skill dir left in place on purpose: harmless, and removal risks deleting user edits
}

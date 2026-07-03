import { join, dirname } from "node:path";
import { homedir } from "node:os";
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
  port?: number;
  noHook?: boolean;
  exec?: ExecFn;
}
export interface InstallReport {
  token: string;
  port: number;
  url: string;
}

// installer.ts is only ever bundled INTO dist/cli.js, so argv[1] IS the cli path
// when invoked via bin. Assets ship next to dist/ (package root), and the hook is
// bundled to dist/hooks/. import.meta.url math is unreliable under splitting:false,
// so anchor production paths on process.argv[1] (same trick as launchd cliPath).
function defaultAssetDir(): string {
  return join(dirname(process.argv[1]), "../assets");
}
function defaultHookPath(): string {
  return join(dirname(process.argv[1]), "hooks/session-start-recall.js");
}

export async function runInstall(o: InstallOptions = {}): Promise<InstallReport> {
  const home = o.home ?? join(homedir(), ".claude/kairos");
  const claudeDir = o.claudeDir ?? join(homedir(), ".claude");
  const claudeJsonPath = o.claudeJsonPath ?? join(homedir(), ".claude.json");
  const assetDir = o.assetDir ?? defaultAssetDir();
  const port = o.port ?? 41414;
  const url = `http://127.0.0.1:${port}/mcp`;

  const token = ensureToken(join(home, "memory", ".backant-memory-token"));
  await installService({ exec: o.exec, port, launchAgentsDir: o.launchAgentsDir, logDir: o.logDir });
  registerMcpServer({ claudeJsonPath, url, token });
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

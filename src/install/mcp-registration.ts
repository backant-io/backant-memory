import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY = "backant-memory";

/**
 * Write the `backant-memory` server entry into ~/.claude.json, merging into any
 * existing config without touching sibling keys. `entry` is the full server
 * object the caller wants under the key — this module stays dumb about transport
 * shape (stdio for Claude Code, http for other agents); the installer decides.
 */
export function registerMcpServer(o: { claudeJsonPath: string; entry: object }): void {
  const j = existsSync(o.claudeJsonPath) ? JSON.parse(readFileSync(o.claudeJsonPath, "utf8")) : {};
  j.mcpServers = j.mcpServers ?? {};
  j.mcpServers[KEY] = o.entry;
  writeFileSync(o.claudeJsonPath, JSON.stringify(j, null, 2) + "\n");
}

export function unregisterMcpServer(o: { claudeJsonPath: string }): void {
  if (!existsSync(o.claudeJsonPath)) return;
  const j = JSON.parse(readFileSync(o.claudeJsonPath, "utf8"));
  if (j.mcpServers && KEY in j.mcpServers) {
    delete j.mcpServers[KEY];
    writeFileSync(o.claudeJsonPath, JSON.stringify(j, null, 2) + "\n");
  }
}

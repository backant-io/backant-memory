import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY = "backant-memory";

export function registerMcpServer(o: { claudeJsonPath: string; url: string; token: string }): void {
  const j = existsSync(o.claudeJsonPath) ? JSON.parse(readFileSync(o.claudeJsonPath, "utf8")) : {};
  j.mcpServers = j.mcpServers ?? {};
  j.mcpServers[KEY] = { type: "http", url: o.url, headers: { Authorization: `Bearer ${o.token}` } };
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

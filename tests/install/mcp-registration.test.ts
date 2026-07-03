import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMcpServer, unregisterMcpServer } from "../../src/install/mcp-registration.js";

describe("registerMcpServer", () => {
  it("merges into existing ~/.claude.json without touching other keys", () => {
    const f = join(mkdtempSync(join(tmpdir(), "mcp-")), ".claude.json");
    writeFileSync(f, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    registerMcpServer({ claudeJsonPath: f, url: "http://127.0.0.1:41414/mcp", token: "T" });
    const j = JSON.parse(readFileSync(f, "utf8"));
    expect(j.theme).toBe("dark");
    expect(j.mcpServers.other.command).toBe("x");
    expect(j.mcpServers["backant-memory"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:41414/mcp",
      headers: { Authorization: "Bearer T" },
    });
    unregisterMcpServer({ claudeJsonPath: f });
    expect(JSON.parse(readFileSync(f, "utf8")).mcpServers["backant-memory"]).toBeUndefined();
  });
});

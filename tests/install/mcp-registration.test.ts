import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMcpServer, unregisterMcpServer } from "../../src/install/mcp-registration.js";

describe("registerMcpServer", () => {
  it("writes the given entry into ~/.claude.json without touching other keys", () => {
    const f = join(mkdtempSync(join(tmpdir(), "mcp-")), ".claude.json");
    writeFileSync(f, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    const entry = { type: "stdio", command: "/opt/backant/bin/backant-memory.js", args: ["serve"] };
    registerMcpServer({ claudeJsonPath: f, entry });
    const j = JSON.parse(readFileSync(f, "utf8"));
    expect(j.theme).toBe("dark");
    expect(j.mcpServers.other.command).toBe("x");
    // The module stays dumb about shape — it writes exactly the entry it was given.
    expect(j.mcpServers["backant-memory"]).toEqual(entry);
    unregisterMcpServer({ claudeJsonPath: f });
    expect(JSON.parse(readFileSync(f, "utf8")).mcpServers["backant-memory"]).toBeUndefined();
    // Sibling keys survive the unregister.
    expect(JSON.parse(readFileSync(f, "utf8")).mcpServers.other.command).toBe("x");
  });
});

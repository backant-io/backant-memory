import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../src/install/installer.js";

describe("runInstall", () => {
  it("wires token, plist, mcp registration, CLAUDE.md, skill, hook — idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "inst-"));
    const exec = vi.fn(async () => ({ stdout: "", code: 0 }));
    const opts = {
      home: join(root, "kairos-home"),
      claudeDir: join(root, ".claude"),
      claudeJsonPath: join(root, ".claude.json"),
      launchAgentsDir: join(root, "LaunchAgents"),
      logDir: join(root, "Logs"),
      assetDir: join(process.cwd(), "assets"),
      port: 45999,
      exec,
    };
    const r1 = await runInstall(opts);
    const r2 = await runInstall(opts);
    expect(r1.token).toBe(r2.token);
    expect(existsSync(join(root, "LaunchAgents", "io.backant.memory.plist"))).toBe(true);
    const cj = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8"));
    expect(cj.mcpServers["backant-memory"].url).toBe("http://127.0.0.1:45999/mcp");
    expect(readFileSync(join(root, ".claude/CLAUDE.md"), "utf8")).toContain("backant-memory:start");
    expect(existsSync(join(root, ".claude/skills/backant-memory/SKILL.md"))).toBe(true);
    const st = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(JSON.stringify(st.hooks.SessionStart)).toContain("session-start-recall");
    expect(exec).toHaveBeenCalled(); // launchctl bootstrap + kickstart
  });
});

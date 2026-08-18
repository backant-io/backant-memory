import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../src/install/installer.js";

describe("runInstall", () => {
  it("wires token, plist, mcp registration, CLAUDE.md, skill, hook — idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "inst-"));
    const exec = vi.fn(async () => ({ stdout: "", code: 0 }));
    const cliPath = "/opt/backant/dist/cli.js";
    const binPath = "/opt/backant/bin/backant-memory.js";
    const opts = {
      home: join(root, "kairos-home"),
      claudeDir: join(root, ".claude"),
      claudeJsonPath: join(root, ".claude.json"),
      launchAgentsDir: join(root, "LaunchAgents"),
      logDir: join(root, "Logs"),
      assetDir: join(process.cwd(), "assets"),
      cliPath,
      binPath,
      port: 45999,
      exec,
    };
    const r1 = await runInstall(opts);
    const r2 = await runInstall(opts);
    expect(r1.token).toBe(r2.token);
    const plistFile = join(root, "LaunchAgents", "io.backant.memory.plist");
    expect(existsSync(plistFile)).toBe(true);
    // plist ProgramArguments must point at the injected cli bundle, never a bin shim
    expect(readFileSync(plistFile, "utf8")).toContain(`<string>${cliPath}</string>`);
    // Claude Code is registered over STDIO: spawn the executable bin shim with `serve`.
    const cj = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8"));
    const entry = cj.mcpServers["backant-memory"];
    expect(entry.type).toBe("stdio");
    expect(entry.command.endsWith("bin/backant-memory.js")).toBe(true);
    expect(entry.command).toBe(binPath);
    expect(entry.args).toEqual(["serve"]);
    // Pinned out of MCP tool-search deferral: otherwise the tools are invisible
    // until the model happens to ToolSearch for them.
    expect(entry.alwaysLoad).toBe(true);
    const claudeMd = readFileSync(join(root, ".claude/CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("backant-memory:start");
    // exactly ONE managed block after two installs
    expect((claudeMd.match(/backant-memory:start/g) ?? []).length).toBe(1);
    expect(existsSync(join(root, ".claude/skills/backant-memory/SKILL.md"))).toBe(true);
    const st = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(JSON.stringify(st.hooks.SessionStart)).toContain("session-start-recall");
    // exactly ONE SessionStart hook command after two installs
    const hookCmds = (st.hooks.SessionStart as Array<{ hooks?: Array<{ command?: string }> }>)
      .flatMap((entry) => entry.hooks ?? [])
      .filter((h) => String(h.command ?? "").includes("session-start-recall"));
    expect(hookCmds.length).toBe(1);
    // Mid-session and end-of-session hooks are wired too (once each).
    expect(JSON.stringify(st.hooks.UserPromptSubmit).split("prompt-recall").length).toBe(2);
    expect(JSON.stringify(st.hooks.PreCompact).split("session-summary").length).toBe(2);
    expect(JSON.stringify(st.hooks.SessionEnd).split("session-summary").length).toBe(2);
    expect(st.hooks.SessionEnd[0].hooks[0].timeout).toBe(20);
    expect(exec).toHaveBeenCalled(); // launchctl bootstrap + kickstart
  });
});

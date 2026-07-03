import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "./paths.js";
import { serviceStatus, plistPath } from "./daemon/launchd.js";
import { siblingIsHealthy } from "./daemon/supervisor.js";

export async function runDoctor(opts: { verifyRestart?: boolean } = {}): Promise<number> {
  const paths = resolvePaths();
  const checks: Array<[string, boolean | string]> = [];
  checks.push(["launchd service", await serviceStatus()]);
  checks.push(["plist present", existsSync(plistPath())]);
  const healthy = await siblingIsHealthy(paths.port);
  checks.push([`http healthz :${paths.port}`, healthy]);
  checks.push(["token file 0600", existsSync(paths.tokenPath) && (statSync(paths.tokenPath).mode & 0o777) === 0o600]);
  const cj = join(homedir(), ".claude.json");
  checks.push(["mcp registered", existsSync(cj) && JSON.stringify(JSON.parse(readFileSync(cj, "utf8")).mcpServers ?? {}).includes("backant-memory")]);
  const cmd = join(homedir(), ".claude/CLAUDE.md");
  checks.push(["CLAUDE.md block", existsSync(cmd) && readFileSync(cmd, "utf8").includes("backant-memory:start")]);
  checks.push(["skill installed", existsSync(join(homedir(), ".claude/skills/backant-memory/SKILL.md"))]);

  if (opts.verifyRestart && healthy) {
    try {
      const pidBefore = (await (await fetch(`http://127.0.0.1:${paths.port}/healthz`)).json()).pid;
      if (typeof pidBefore !== "number" || pidBefore <= 1) {
        checks.push(["relaunch after SIGKILL (no valid pid)", false]);
      } else {
        process.kill(pidBefore, "SIGKILL");
        let pidAfter = pidBefore;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            pidAfter = (await (await fetch(`http://127.0.0.1:${paths.port}/healthz`)).json()).pid;
            if (pidAfter !== pidBefore) break;
          } catch {}
        }
        checks.push(["relaunch after SIGKILL", pidAfter !== pidBefore]);
      }
    } catch (e) {
      checks.push([`relaunch after SIGKILL (error: ${e})`, false]);
    }
  }

  let ok = true;
  for (const [name, val] of checks) {
    const pass = val === true || val === "running";
    if (!pass) ok = false;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${typeof val === "string" ? ` (${val})` : ""}`);
  }
  return ok ? 0 : 1;
}

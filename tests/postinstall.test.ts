import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPlist } from "../src/daemon/launchd.js";

const POSTINSTALL = join(process.cwd(), "dist", "postinstall.js");

/**
 * Proves the SHIPPED postinstall applies the ownership guard, not just that
 * shouldRewritePlist computes it. Issue #3 was exactly this wiring: dropping
 * the guard here re-breaks the machine's service while the unit tests stay
 * green.
 *
 * Safe by construction: HOME points at a temp dir (node's os.homedir() honours
 * $HOME on POSIX, which is how plistPath() resolves), and the one case
 * exercised is the one that must invoke launchctl zero times and write
 * nothing — so a broken guard fails the assertions instead of touching the
 * developer's real service.
 */
describe("dist/postinstall.js ownership guard", () => {
  it("leaves a plist owned by another install untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "bam-postinstall-"));
    try {
      const agents = join(home, "Library/LaunchAgents");
      mkdirSync(agents, { recursive: true });
      const plistFile = join(agents, "io.backant.memory.plist");
      // A plist run by a *different* install — the global one, in the wild.
      const foreign = renderPlist({
        nodePath: "/opt/homebrew/bin/node",
        cliPath: "/opt/homebrew/lib/node_modules/backant-memory/dist/cli.js",
        port: 41414,
        logDir: join(home, "logs"),
      });
      writeFileSync(plistFile, foreign);

      // No npm_config_global / npm_config_location => a dependency install,
      // which is what `npm install` inside a consuming repo looks like.
      const { npm_config_global, npm_config_location, ...env } = process.env;
      const r = spawnSync(process.execPath, [POSTINSTALL], {
        env: { ...env, HOME: home },
        encoding: "utf8",
      });

      expect(readFileSync(plistFile, "utf8")).toBe(foreign);
      expect(r.stderr).toContain("left untouched");
      // launchctl is never reached, so nothing was kickstarted either.
      expect(r.stderr).not.toContain("service refreshed");
      // postinstall must never fail `npm install`.
      expect(r.status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

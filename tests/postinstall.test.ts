import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPlist } from "../src/daemon/launchd.js";

const PKGROOT = process.cwd();
const POSTINSTALL = join(PKGROOT, "dist", "postinstall.js");
const FOREIGN = "/opt/homebrew/lib/node_modules/backant-memory/dist/cli.js";

function plistWith(programArgs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>io.backant.memory</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
</dict>
</plist>
`;
}

/**
 * Runs the SHIPPED dist/postinstall.js against a plist we control.
 *
 * Isolation, and why each piece is needed:
 *  - HOME is a temp dir, which is how plistPath() resolves (node's os.homedir()
 *    honours $HOME on POSIX), so the developer's real plist is out of reach.
 *  - `launchctl` is shadowed by a logging stub first on PATH, so even a
 *    regressed guard cannot bootstrap or kickstart the real user session — and
 *    the log doubles as the assertion that the service was left alone.
 *  - cwd is the package root, because that is what npm sets for lifecycle
 *    scripts and it is what made a relative ProgramArguments entry resolve
 *    *inside* the install prefix.
 * Nothing here is global: npm_config_global / npm_config_location are stripped,
 * so every case below is a plain dependency install.
 */
function runPostinstall(plistXml?: string) {
  const home = mkdtempSync(join(tmpdir(), "bam-postinstall-"));
  const agents = join(home, "Library/LaunchAgents");
  const bin = join(home, "bin");
  mkdirSync(agents, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const log = join(home, "launchctl.log");
  const stub = join(bin, "launchctl");
  writeFileSync(stub, `#!/bin/sh\necho "launchctl $*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(stub, 0o755);

  const plistFile = join(agents, "io.backant.memory.plist");
  if (plistXml !== undefined) writeFileSync(plistFile, plistXml);

  const { npm_config_global, npm_config_location, ...env } = process.env;
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    cwd: PKGROOT,
    env: { ...env, HOME: home, PATH: `${bin}:${env.PATH ?? ""}` },
    encoding: "utf8",
  });

  return {
    status: r.status,
    stderr: r.stderr,
    plist: existsSync(plistFile) ? readFileSync(plistFile, "utf8") : undefined,
    launchctl: existsSync(log) ? readFileSync(log, "utf8") : "",
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/**
 * Proves the SHIPPED postinstall applies the ownership guard, not just that
 * shouldRewritePlist computes it. Issue #3 was exactly this wiring: drop the
 * guard from the entry and the machine's service breaks again while the unit
 * tests stay green.
 */
describe("dist/postinstall.js ownership guard", () => {
  const leaveAlone: Array<[string, string[]]> = [
    [
      "a plist owned by another install",
      ["/opt/homebrew/bin/node", FOREIGN, "serve", "--http", "--port", "41414"],
    ],
    // Both shapes put a non-path in slot 1. With cwd === the install prefix, a
    // resolve()-only containment check read them as ours and rewrote the plist.
    ["a foreign plist run through /usr/bin/env", ["/usr/bin/env", "node", FOREIGN, "serve"]],
    [
      "a foreign plist with a node flag before the script",
      ["/opt/homebrew/bin/node", "--enable-source-maps", FOREIGN],
    ],
  ];

  it.each(leaveAlone)("leaves %s untouched", (_label, programArgs) => {
    const xml = plistWith(programArgs);
    const r = runPostinstall(xml);
    try {
      expect(r.plist).toBe(xml);
      expect(r.launchctl).toBe(""); // never bootstrapped, never kickstarted
      expect(r.stderr).toContain("left untouched");
      expect(r.stderr).not.toContain("service refreshed");
      expect(r.status).toBe(0); // postinstall must never fail `npm install`
    } finally {
      r.cleanup();
    }
  });

  it("still refreshes a plist that already runs this install", () => {
    // The negative cases above would also pass a guard that never rewrites
    // anything; this pins the other direction of the same decision.
    const xml = renderPlist({
      nodePath: process.execPath,
      cliPath: join(PKGROOT, "dist", "cli.js"),
      port: 41414,
      logDir: join(PKGROOT, "logs"),
    });
    const r = runPostinstall(xml);
    try {
      expect(r.stderr).toContain("service refreshed");
      expect(r.launchctl).toContain("bootstrap");
      expect(r.launchctl).toContain("kickstart");
      expect(r.status).toBe(0);
    } finally {
      r.cleanup();
    }
  });

  it("does nothing at all when there is no plist", () => {
    const r = runPostinstall(undefined);
    try {
      expect(r.plist).toBeUndefined();
      expect(r.launchctl).toBe("");
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      r.cleanup();
    }
  });
});

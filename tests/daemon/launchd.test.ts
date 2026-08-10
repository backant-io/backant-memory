import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  renderPlist,
  installService,
  uninstallService,
  serviceStatus,
  plistPath,
  logDir,
  isGlobalNpmInstall,
  parsePlistProgramPath,
  shouldRewritePlist,
} from "../../src/daemon/launchd.js";

describe("renderPlist", () => {
  it("is deterministic and contains the survivability keys", () => {
    const p = renderPlist({ nodePath: "/usr/local/bin/node", cliPath: "/g/dist/cli.js", port: 41414, logDir: "/logs" });
    expect(p).toContain("<key>Label</key>");
    expect(p).toContain("<string>io.backant.memory</string>");
    expect(p).toContain("<key>RunAtLoad</key>");
    expect(p).toContain("<key>KeepAlive</key>");
    expect(p).toContain("<string>/usr/local/bin/node</string>");
    expect(p).toContain("<string>/g/dist/cli.js</string>");
    expect(p).toContain("<string>serve</string>");
    expect(p).toContain("<string>--http</string>");
    expect(p).toContain("<string>41414</string>");
    expect(p).toContain("/logs/stdout.log");
    expect(renderPlist({ nodePath: "/usr/local/bin/node", cliPath: "/g/dist/cli.js", port: 41414, logDir: "/logs" })).toBe(p);
  });
});

describe("path helpers", () => {
  it("plistPath honors an injected launchAgentsDir and defaults to ~/Library/LaunchAgents", () => {
    expect(plistPath("/tmp/la")).toBe("/tmp/la/io.backant.memory.plist");
    expect(plistPath()).toBe(join(homedir(), "Library/LaunchAgents/io.backant.memory.plist"));
  });

  it("logDir honors an injected dir and defaults to ~/Library/Logs/backant-memory", () => {
    expect(logDir("/tmp/logs")).toBe("/tmp/logs");
    expect(logDir()).toBe(join(homedir(), "Library/Logs/backant-memory"));
  });
});

describe("launchctl wrappers", () => {
  it("bootstrap tolerates already-bootstrapped, kickstarts after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-launchd-"));
    const calls: string[][] = [];
    const exec = vi.fn(async (_c: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "bootstrap") return { stdout: "Bootstrap failed: 5: Input/output error", code: 5 };
      return { stdout: "", code: 0 };
    });
    await installService({ exec, launchAgentsDir: dir, logDir: join(dir, "logs") });
    expect(calls.some(a => a[0] === "bootstrap")).toBe(true);
    expect(calls.some(a => a[0] === "kickstart")).toBe(true);
    expect(existsSync(join(dir, "io.backant.memory.plist"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when bootstrap fails with a real error code (not 0 or 5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-launchd-"));
    const exec = vi.fn(async (_c: string, args: string[]) =>
      args[0] === "bootstrap"
        ? { stdout: "Bootstrap failed: 1: Operation not permitted", code: 1 }
        : { stdout: "", code: 0 });
    await expect(
      installService({ exec, launchAgentsDir: dir, logDir: join(dir, "logs") })
    ).rejects.toThrow(/bootstrap failed \(code 1\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when kickstart fails after a successful bootstrap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-launchd-"));
    const exec = vi.fn(async (_c: string, args: string[]) =>
      args[0] === "kickstart"
        ? { stdout: "Could not find service", code: 3 }
        : { stdout: "", code: 0 });
    await expect(
      installService({ exec, launchAgentsDir: dir, logDir: join(dir, "logs") })
    ).rejects.toThrow(/kickstart failed \(code 3\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uninstall tolerates a failing bootout (service may not be loaded)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-launchd-"));
    const install = vi.fn(async () => ({ stdout: "", code: 0 }));
    await installService({ exec: install, launchAgentsDir: dir, logDir: join(dir, "logs") });
    const exec = vi.fn(async () => ({ stdout: "Boot-out failed: 3: No such process", code: 3 }));
    await expect(uninstallService({ exec, launchAgentsDir: dir })).resolves.toBeUndefined();
    expect(existsSync(join(dir, "io.backant.memory.plist"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("installService writes the plist and creates the log dir under injected dirs only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-launchd-"));
    const ld = join(dir, "logs");
    const exec = vi.fn(async () => ({ stdout: "", code: 0 }));
    await installService({ exec, port: 55555, launchAgentsDir: dir, logDir: ld });
    const plist = join(dir, "io.backant.memory.plist");
    expect(existsSync(plist)).toBe(true);
    expect(existsSync(ld)).toBe(true);
    const content = readFileSync(plist, "utf8");
    expect(content).toContain("<string>io.backant.memory</string>");
    expect(content).toContain("<string>55555</string>");
    expect(content).toContain(`${ld}/stdout.log`);
    // node execPath + argv[1] (cli path) are embedded, not import.meta path math
    expect(content).toContain(`<string>${process.execPath}</string>`);
    expect(content).toContain(`<string>${process.argv[1]}</string>`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uninstallService boots out and deletes the plist from the injected dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-launchd-"));
    const install = vi.fn(async () => ({ stdout: "", code: 0 }));
    await installService({ exec: install, launchAgentsDir: dir, logDir: join(dir, "logs") });
    const plist = join(dir, "io.backant.memory.plist");
    expect(existsSync(plist)).toBe(true);

    const calls: string[][] = [];
    const exec = vi.fn(async (_c: string, args: string[]) => { calls.push(args); return { stdout: "", code: 0 }; });
    await uninstallService({ exec, launchAgentsDir: dir });
    expect(calls.some(a => a[0] === "bootout")).toBe(true);
    expect(existsSync(plist)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("status maps launchctl print output", async () => {
    const running = vi.fn(async () => ({ stdout: "state = running", code: 0 }));
    expect(await serviceStatus({ exec: running })).toBe("running");
    const loaded = vi.fn(async () => ({ stdout: "state = waiting", code: 0 }));
    expect(await serviceStatus({ exec: loaded })).toBe("loaded");
    const missing = vi.fn(async () => ({ stdout: "", code: 113 }));
    expect(await serviceStatus({ exec: missing })).toBe("not-installed");
  });
});

/**
 * Guard for the postinstall plist rewrite (issue #3). A dependency install must
 * never repoint the machine's one launchd service at its own node_modules: when
 * that tree is a git worktree it gets deleted, and KeepAlive then respawns a
 * missing file forever. Only the owner of the service may rewrite it.
 */
describe("isGlobalNpmInstall", () => {
  // Semantics verified empirically against npm 10.9.9 and npm 11.12.1: `-g`
  // exports npm_config_global="true"; a dependency install exports the key not
  // at all (npm omits configs left at their default), so presence-vs-absence —
  // not a truthiness check on a "false" string — is what distinguishes them.
  it("is true only for a global install (npm_config_global=true)", () => {
    expect(isGlobalNpmInstall({ npm_config_global: "true" })).toBe(true);
  });

  it("is false when npm_config_global is absent — that is a dependency install", () => {
    expect(isGlobalNpmInstall({})).toBe(false);
    expect(isGlobalNpmInstall({ npm_config_local_prefix: "/repo" })).toBe(false);
  });

  it("is false for an explicitly non-global value, not merely a missing key", () => {
    expect(isGlobalNpmInstall({ npm_config_global: "false" })).toBe(false);
    expect(isGlobalNpmInstall({ npm_config_global: "" })).toBe(false);
  });

  // `npm install --location=global` is the other spelling of `-g`. It exports
  // npm_config_location="global" and leaves npm_config_global unset (verified
  // on npm 10.9.9 and 11.12.1), so global-ness needs both keys.
  it("is true for the --location=global spelling of a global install", () => {
    expect(isGlobalNpmInstall({ npm_config_location: "global" })).toBe(true);
    expect(isGlobalNpmInstall({ npm_config_location: "user" })).toBe(false);
  });
});

describe("parsePlistProgramPath", () => {
  it("reads back the cli path that renderPlist wrote", () => {
    const xml = renderPlist({
      nodePath: "/opt/homebrew/bin/node",
      cliPath: "/opt/homebrew/lib/node_modules/backant-memory/dist/cli.js",
      port: 41414,
      logDir: "/logs",
    });
    expect(parsePlistProgramPath(xml)).toBe(
      "/opt/homebrew/lib/node_modules/backant-memory/dist/cli.js"
    );
  });

  it("returns undefined for a plist it cannot understand", () => {
    // An unreadable plist must not be mistaken for one pointing at us — the
    // caller has to fall back to the ownership check, not to a rewrite.
    expect(parsePlistProgramPath("not a plist")).toBeUndefined();
    expect(parsePlistProgramPath("<plist><dict></dict></plist>")).toBeUndefined();
    expect(
      parsePlistProgramPath(
        "<key>ProgramArguments</key><array><string>/bin/node</string></array>"
      )
    ).toBeUndefined();
  });
});

describe("shouldRewritePlist", () => {
  const OURS = "/repo/.worktrees/wt/node_modules/backant-memory";
  const GLOBAL = "/opt/homebrew/lib/node_modules/backant-memory";
  const foreign = `${GLOBAL}/dist/cli.js`;
  const own = `${OURS}/dist/cli.js`;

  it("rewrites on a global install even when the plist points elsewhere", () => {
    // A global install owns the machine's service: taking over a plist left by
    // a previous prefix is the intended upgrade path.
    expect(
      shouldRewritePlist({
        plistExists: true,
        isGlobalInstall: true,
        plistProgramPath: foreign,
        installPrefix: OURS,
      })
    ).toBe(true);
  });

  it("rewrites on a global install that is refreshing its own plist", () => {
    expect(
      shouldRewritePlist({
        plistExists: true,
        isGlobalInstall: true,
        plistProgramPath: `${GLOBAL}/dist/cli.js`,
        installPrefix: GLOBAL,
      })
    ).toBe(true);
  });

  it("leaves a foreign plist alone on a dependency install", () => {
    // Issue #3 verbatim: `npm install` inside a kairos worktree must not
    // repoint the live service at the worktree's node_modules.
    expect(
      shouldRewritePlist({
        plistExists: true,
        isGlobalInstall: false,
        plistProgramPath: foreign,
        installPrefix: OURS,
      })
    ).toBe(false);
  });

  it("rewrites on a dependency install that already owns the plist", () => {
    // Re-installing over yourself only refreshes what you already run, so the
    // upgrade path for a dependency-hosted service still works.
    expect(
      shouldRewritePlist({
        plistExists: true,
        isGlobalInstall: false,
        plistProgramPath: own,
        installPrefix: OURS,
      })
    ).toBe(true);
  });

  it("does nothing when no plist exists, for either install type", () => {
    // Unchanged pre-0.2.1 behavior: postinstall never *creates* the service —
    // `backant-memory install` does. First install stays a no-op.
    for (const isGlobalInstall of [true, false]) {
      expect(
        shouldRewritePlist({ plistExists: false, isGlobalInstall, installPrefix: OURS })
      ).toBe(false);
    }
  });

  it("does not treat a sibling directory as its own prefix", () => {
    // `/…/backant-memory-old` shares a string prefix with `/…/backant-memory`;
    // ownership is a path-containment question, not a startsWith question.
    expect(
      shouldRewritePlist({
        plistExists: true,
        isGlobalInstall: false,
        plistProgramPath: `${OURS}-old/dist/cli.js`,
        installPrefix: OURS,
      })
    ).toBe(false);
  });

  it("leaves an unparseable plist alone on a dependency install", () => {
    // Unknown owner + no mandate to take over = hands off.
    expect(
      shouldRewritePlist({
        plistExists: true,
        isGlobalInstall: false,
        plistProgramPath: undefined,
        installPrefix: OURS,
      })
    ).toBe(false);
  });

  it("normalizes both sides before comparing", () => {
    expect(
      shouldRewritePlist({
        plistExists: true,
        isGlobalInstall: false,
        plistProgramPath: `${OURS}/dist/../dist/cli.js`,
        installPrefix: `${OURS}/`,
      })
    ).toBe(true);
  });
});

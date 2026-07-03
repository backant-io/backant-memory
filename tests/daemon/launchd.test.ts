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

import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const SERVICE_LABEL = "io.backant.memory";
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) =>
      resolve({
        stdout: `${stdout}${stderr}`,
        code: err && typeof (err as NodeJS.ErrnoException).code === "number" ? (err as any).code : err ? 1 : 0,
      }));
  });

export function plistPath(launchAgentsDir?: string): string {
  return join(launchAgentsDir ?? join(homedir(), "Library/LaunchAgents"), `${SERVICE_LABEL}.plist`);
}

export function logDir(dir?: string): string {
  return dir ?? join(homedir(), "Library/Logs/backant-memory");
}

export function renderPlist(o: { nodePath: string; cliPath: string; port: number; logDir: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${o.nodePath}</string>
    <string>${o.cliPath}</string>
    <string>serve</string>
    <string>--http</string>
    <string>--port</string>
    <string>${o.port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${o.logDir}/stdout.log</string>
  <key>StandardErrorPath</key><string>${o.logDir}/stderr.log</string>
</dict>
</plist>
`;
}

function uid(): number { return process.getuid ? process.getuid() : 501; }

export async function installService(
  opts: { exec?: ExecFn; port?: number; launchAgentsDir?: string; logDir?: string; cliPath?: string } = {}
): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  const port = opts.port ?? 41414;
  const ld = logDir(opts.logDir);
  const plist = plistPath(opts.launchAgentsDir);
  mkdirSync(ld, { recursive: true });
  mkdirSync(dirname(plist), { recursive: true });
  // Callers must pass an explicit cliPath pointing at dist/cli.js. argv[1] is
  // only a back-compat fallback: under the global bin it is the bin shim, and
  // under npm postinstall it is dist/postinstall.js — both wrong for the plist.
  const cliPath = opts.cliPath ?? process.argv[1];
  writeFileSync(plist, renderPlist({ nodePath: process.execPath, cliPath, port, logDir: ld }));
  await exec("launchctl", ["bootstrap", `gui/${uid()}`, plist]); // code 5 = already bootstrapped: fine
  await exec("launchctl", ["kickstart", "-k", `gui/${uid()}/${SERVICE_LABEL}`]);
}

export async function uninstallService(
  opts: { exec?: ExecFn; launchAgentsDir?: string } = {}
): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  await exec("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]); // not-loaded: fine
  rmSync(plistPath(opts.launchAgentsDir), { force: true });
}

export async function serviceStatus(
  opts: { exec?: ExecFn } = {}
): Promise<"running" | "loaded" | "not-installed"> {
  const exec = opts.exec ?? defaultExec;
  const { stdout, code } = await exec("launchctl", ["print", `gui/${uid()}/${SERVICE_LABEL}`]);
  if (code !== 0) return "not-installed";
  return /state = running/.test(stdout) ? "running" : "loaded";
}

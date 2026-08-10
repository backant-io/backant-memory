import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, relative, resolve } from "node:path";

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

/**
 * Ownership rules for the one launchd plist on the machine (issue #3).
 *
 * postinstall runs for every install of this package, including as a
 * dependency of something else. Rewriting the plist unconditionally repoints
 * the live service at whatever tree is being installed — and when that tree is
 * a git worktree's node_modules it later disappears, leaving KeepAlive to
 * respawn a missing file forever. So only the service's owner may rewrite it.
 */

/**
 * Semantics verified against npm 10.9.9 and 11.12.1: `-g` exports
 * npm_config_global="true"; `--location=global` exports
 * npm_config_location="global" and leaves npm_config_global unset; a
 * dependency install exports neither key (npm omits configs left at default).
 */
export function isGlobalNpmInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.npm_config_global === "true" || env.npm_config_location === "global";
}

/** The script path an existing plist runs, or undefined if it does not parse. */
export function parsePlistProgramPath(xml: string): string | undefined {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!block) return undefined;
  // renderPlist emits [nodePath, cliPath, "serve", …] — the script is second.
  const args = [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1].trim());
  return args.length > 1 ? args[1] : undefined;
}

function isInsidePrefix(prefix: string, target: string): boolean {
  // Path containment, not string prefixing: `/x/pkg-old` is not inside `/x/pkg`.
  const rel = relative(resolve(prefix), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function shouldRewritePlist(o: {
  plistExists: boolean;
  isGlobalInstall: boolean;
  plistProgramPath?: string;
  installPrefix: string;
}): boolean {
  // postinstall never creates the service — `backant-memory install` does.
  if (!o.plistExists) return false;
  // A global install owns the machine's service, whatever it points at today.
  if (o.isGlobalInstall) return true;
  // Otherwise only a self-refresh: the plist already runs files from this tree.
  return o.plistProgramPath !== undefined && isInsidePrefix(o.installPrefix, o.plistProgramPath);
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
  // Acceptable bootstrap codes: 0 (loaded) and 5 (already bootstrapped). Anything
  // else is a real failure — surface it instead of reporting a false success.
  const boot = await exec("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
  if (boot.code !== 0 && boot.code !== 5) {
    throw new Error(`launchctl bootstrap failed (code ${boot.code}): ${boot.stdout}`);
  }
  const kick = await exec("launchctl", ["kickstart", "-k", `gui/${uid()}/${SERVICE_LABEL}`]);
  if (kick.code !== 0) {
    throw new Error(`launchctl kickstart failed (code ${kick.code}): ${kick.stdout}`);
  }
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

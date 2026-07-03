export interface ExecResult { code: number; stdout: string; stderr: string; }
export interface AvailabilityDeps {
  exec?: (cmd: string, args: string[]) => Promise<ExecResult>;
}

export async function isDockerAvailable(deps: AvailabilityDeps = {}): Promise<boolean> {
  const runner = deps.exec ?? (await defaultExec());
  try {
    const r = await runner("docker", ["--version"]);
    return r.code === 0;
  } catch {
    return false;
  }
}

async function defaultExec() {
  const { execFile } = await import("node:child_process");
  return (cmd: string, args: string[]): Promise<ExecResult> =>
    new Promise((resolve) => {
      execFile(cmd, args, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ code: 127, stdout: "", stderr: String(err) });
          return;
        }
        resolve({
          code: err ? ((err as any).code ?? 1) : 0,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      });
    });
}

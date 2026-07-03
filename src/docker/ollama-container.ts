import { mkdirSync } from "node:fs";
import type { ExecResult } from "./availability.js";

export const IMAGE_NAME = "ollama/ollama";
export const CONTAINER_NAME = "kairos-ollama";
export const HOST_PORT = 11434;

export interface ContainerDeps {
  exec?: (cmd: string, args: string[]) => Promise<ExecResult>;
  modelsVolumePath?: string;
}

export async function ensureOllamaImage(deps: ContainerDeps = {}): Promise<{
  status: "already_present" | "pulled" | "failed";
  reason?: string;
}> {
  const runner = deps.exec ?? (await defaultExec());
  const inspect = await runner("docker", ["image", "inspect", IMAGE_NAME]);
  if (inspect.code === 0) return { status: "already_present" };
  const pull = await runner("docker", ["pull", IMAGE_NAME]);
  if (pull.code !== 0) return { status: "failed", reason: pull.stderr || `exit ${pull.code}` };
  return { status: "pulled" };
}

export type ContainerState = "running" | "stopped" | "missing";

export async function containerState(
  deps: ContainerDeps = {}
): Promise<{ state: ContainerState }> {
  const runner = deps.exec ?? (await defaultExec());
  const running = await runner("docker", [
    "ps", "--filter", `name=^${CONTAINER_NAME}$`, "--format", "{{.Names}}",
  ]);
  if (running.code === 0 && running.stdout.includes(CONTAINER_NAME)) {
    return { state: "running" };
  }
  const any = await runner("docker", [
    "ps", "-a", "--filter", `name=^${CONTAINER_NAME}$`, "--format", "{{.Names}}",
  ]);
  if (any.code === 0 && any.stdout.includes(CONTAINER_NAME)) {
    return { state: "stopped" };
  }
  return { state: "missing" };
}

export interface EnsureResult {
  action: "already_running" | "started" | "created" | "failed";
  reason?: string;
}

export async function ensureOllamaContainer(
  deps: ContainerDeps & { modelsVolumePath: string }
): Promise<EnsureResult> {
  const runner = deps.exec ?? (await defaultExec());
  mkdirSync(deps.modelsVolumePath, { recursive: true });

  const { state } = await containerState({ exec: runner });
  if (state === "running") return { action: "already_running" };
  if (state === "stopped") {
    const r = await runner("docker", ["start", CONTAINER_NAME]);
    if (r.code !== 0) return { action: "failed", reason: r.stderr };
    return { action: "started" };
  }
  const r = await runner("docker", [
    "run", "-d",
    "--name", CONTAINER_NAME,
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${HOST_PORT}:11434`,
    "-v", `${deps.modelsVolumePath}:/root/.ollama`,
    IMAGE_NAME,
  ]);
  if (r.code !== 0) return { action: "failed", reason: r.stderr };
  return { action: "created" };
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

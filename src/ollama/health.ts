import { homedir } from "node:os";
import { join } from "node:path";
import { OllamaClient } from "./client.js";
import { isDockerAvailable } from "../docker/availability.js";
import { ensureOllamaContainer, type EnsureResult } from "../docker/ollama-container.js";

export type HealthStatus =
  | "already_running"
  | "started"
  | "docker_missing"
  | "failed";

export interface HealthOptions {
  client?: OllamaClient;
  ensureDockerAvailable?: () => Promise<boolean>;
  ensureContainer?: (opts: { modelsVolumePath: string }) => Promise<EnsureResult>;
  modelsVolumePath?: string;
  waitIntervalMs?: number;
  maxWaitMs?: number;
}

/** Pure reachability check (no side effects): is the Ollama embedding backend up? */
export async function isMemoryBackendReachable(
  client: OllamaClient = new OllamaClient()
): Promise<boolean> {
  return client.ping();
}

export async function ensureOllamaRunning(
  opts: HealthOptions = {}
): Promise<{ status: HealthStatus; reason?: string }> {
  const client = opts.client ?? new OllamaClient();
  const ensureDocker = opts.ensureDockerAvailable ?? isDockerAvailable;
  const ensureContainer = opts.ensureContainer ?? ((args) => ensureOllamaContainer(args));
  const modelsPath = opts.modelsVolumePath ?? join(homedir(), ".claude/kairos/models");
  const interval = opts.waitIntervalMs ?? 500;
  const maxWait = opts.maxWaitMs ?? 30_000;

  if (await client.ping()) {
    return { status: "already_running" };
  }

  if (!(await ensureDocker())) {
    return {
      status: "docker_missing",
      reason: "Docker is required to run Ollama. Install Docker Desktop (Mac/Windows) or Docker Engine (Linux), then re-run `backant memory init`.",
    };
  }

  const result = await ensureContainer({ modelsVolumePath: modelsPath });
  if (result.action === "failed") {
    return { status: "failed", reason: result.reason };
  }

  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (await client.ping()) return { status: "started" };
  }
  return { status: "failed", reason: "container created/started but Ollama API did not respond in time" };
}

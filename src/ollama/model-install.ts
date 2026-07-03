import { OllamaClient } from "./client.js";

export type InstallStatus = "already_installed" | "installed" | "failed";

export interface InstallOptions {
  client: OllamaClient;
  model: string;
  onProgress?: (event: { status: string; completed?: number; total?: number; error?: string }) => void;
}

export async function ensureModelInstalled(
  opts: InstallOptions
): Promise<{ status: InstallStatus; reason?: string }> {
  const installed = await opts.client.listModels();
  if (installed.includes(opts.model)) {
    return { status: "already_installed" };
  }

  const onProgress = opts.onProgress ?? (() => {});
  try {
    await opts.client.pull(opts.model, onProgress);
  } catch (err) {
    return { status: "failed", reason: (err as Error).message };
  }

  const refreshed = await opts.client.listModels();
  if (!refreshed.includes(opts.model)) {
    return { status: "failed", reason: "model not found after pull" };
  }
  return { status: "installed" };
}

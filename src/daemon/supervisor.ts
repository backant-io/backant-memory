import { ensureOllamaRunning } from "../ollama/health.js";

export async function siblingIsHealthy(
  port: number,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

export function startSupervisor(opts: {
  intervalMs?: number;
  ensure?: typeof ensureOllamaRunning;
  log?: (msg: string) => void;
} = {}): { stop(): void } {
  const interval = opts.intervalMs ?? 60_000;
  const ensure = opts.ensure ?? ensureOllamaRunning;
  const log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
  let last: string | null = null;
  const timer = setInterval(async () => {
    try {
      const { status, reason } = await ensure();
      if (status !== last) {
        log(`[supervisor] ollama: ${last ?? "(start)"} -> ${status}${reason ? ` (${reason})` : ""}`);
        last = status;
      }
    } catch (err) {
      if (last !== "error") { log(`[supervisor] ollama check error: ${String(err)}`); last = "error"; }
    }
  }, interval);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

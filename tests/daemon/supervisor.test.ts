import { describe, it, expect, vi } from "vitest";
import { siblingIsHealthy, startSupervisor } from "../../src/daemon/supervisor.js";

describe("siblingIsHealthy", () => {
  it("true on ok:true, false on connection refused", async () => {
    const okFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await siblingIsHealthy(41414, okFetch as any)).toBe(true);
    const refuse = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await siblingIsHealthy(41414, refuse as any)).toBe(false);
  });
});

describe("startSupervisor", () => {
  it("calls ensure on interval and logs transitions only", async () => {
    vi.useFakeTimers();
    const statuses = ["already_running", "already_running", "failed", "already_running"];
    const ensure = vi.fn(async () => ({ status: statuses.shift() ?? "already_running" } as any));
    const log = vi.fn();
    const sup = startSupervisor({ intervalMs: 1000, ensure, log });
    await vi.advanceTimersByTimeAsync(4000);
    sup.stop();
    expect(ensure).toHaveBeenCalledTimes(4);
    // transitions: (start->already_running), already_running->failed, failed->already_running
    expect(log.mock.calls.length).toBe(3);
    vi.useRealTimers();
  });
});

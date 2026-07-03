import { describe, it, expect, vi } from "vitest";
import { resolveConnection } from "../../src/memory/provision.js";
import { deriveIdentity } from "../../src/memory/repo-identity.js";

describe("resolveConnection", () => {
  it("local-only identity skips the backend and returns a file path", async () => {
    const conn = await resolveConnection({
      identity: deriveIdentity(null),
      kairosHome: "/tmp/k",
      token: "t",
      fetchImpl: vi.fn() as never,
    });
    expect(conn.localPath).toContain("ns-__local__.db");
    expect(conn.syncUrl).toBeUndefined();
  });

  it("remote identity provisions and returns replica opts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ syncUrl: "https://sqld/backant-io", namespace: "backant-io", scopedToken: "tok" }),
    });
    const conn = await resolveConnection({
      identity: deriveIdentity("git@github.com:backant-io/backant-send.git"),
      kairosHome: "/tmp/k",
      token: "usr",
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/kairos/memory/provision");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ owner: "backant-io" });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer usr" });
    expect(conn.syncUrl).toBe("https://sqld/backant-io");
    expect(conn.authToken).toBe("tok");
    expect(conn.localPath).toContain("ns-backant-io.db");
  });

  it("throws loudly when the backend rejects provisioning", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    await expect(
      resolveConnection({
        identity: deriveIdentity("git@github.com:other/repo.git"),
        kairosHome: "/tmp/k",
        token: null,
        fetchImpl: fetchImpl as never,
      })
    ).rejects.toThrow(/provision failed: 403/);
  });
});

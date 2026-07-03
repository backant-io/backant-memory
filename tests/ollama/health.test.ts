import { describe, it, expect, vi, afterEach } from "vitest";
import { ensureOllamaRunning } from "../../src/ollama/health.js";
import { OllamaClient } from "../../src/ollama/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureOllamaRunning", () => {
  it("returns 'already_running' when ping succeeds immediately", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "ping").mockResolvedValue(true);
    const ensureContainer = vi.fn();
    const r = await ensureOllamaRunning({
      client,
      ensureContainer,
      ensureDockerAvailable: async () => true,
      waitIntervalMs: 5, maxWaitMs: 50,
    });
    expect(r.status).toBe("already_running");
    expect(ensureContainer).not.toHaveBeenCalled();
  });

  it("calls ensureContainer when ping fails, then waits for ping", async () => {
    const client = new OllamaClient();
    const pings = [false, false, true];
    let i = 0;
    vi.spyOn(client, "ping").mockImplementation(async () => pings[i++] ?? true);
    const ensureContainer = vi.fn().mockResolvedValue({ action: "created" });
    const r = await ensureOllamaRunning({
      client,
      ensureContainer,
      ensureDockerAvailable: async () => true,
      waitIntervalMs: 5, maxWaitMs: 200,
    });
    expect(ensureContainer).toHaveBeenCalled();
    expect(r.status).toBe("started");
  });

  it("returns 'docker_missing' when docker is not available", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "ping").mockResolvedValue(false);
    const ensureContainer = vi.fn();
    const r = await ensureOllamaRunning({
      client,
      ensureContainer,
      ensureDockerAvailable: async () => false,
      waitIntervalMs: 5, maxWaitMs: 30,
    });
    expect(r.status).toBe("docker_missing");
    expect(ensureContainer).not.toHaveBeenCalled();
  });

  it("returns 'failed' when container could not be brought up in time", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "ping").mockResolvedValue(false);
    const ensureContainer = vi.fn().mockResolvedValue({ action: "created" });
    const r = await ensureOllamaRunning({
      client,
      ensureContainer,
      ensureDockerAvailable: async () => true,
      waitIntervalMs: 5, maxWaitMs: 20,
    });
    expect(r.status).toBe("failed");
  });
});

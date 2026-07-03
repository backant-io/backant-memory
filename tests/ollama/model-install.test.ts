import { describe, it, expect, vi } from "vitest";
import { ensureModelInstalled } from "../../src/ollama/model-install.js";
import { OllamaClient } from "../../src/ollama/client.js";

describe("ensureModelInstalled", () => {
  it("returns 'already_installed' when model is in listModels", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "listModels").mockResolvedValue([
      "qwen3-embedding:0.6b",
      "other:latest",
    ]);
    const pullSpy = vi.spyOn(client, "pull");
    const r = await ensureModelInstalled({ client, model: "qwen3-embedding:0.6b" });
    expect(r.status).toBe("already_installed");
    expect(pullSpy).not.toHaveBeenCalled();
  });

  it("calls client.pull when model missing and re-checks listModels", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "listModels")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["qwen3-embedding:0.6b"]);
    const pullSpy = vi.spyOn(client, "pull").mockResolvedValue({ status: "success" });
    const r = await ensureModelInstalled({ client, model: "qwen3-embedding:0.6b" });
    expect(pullSpy).toHaveBeenCalledWith("qwen3-embedding:0.6b", expect.any(Function));
    expect(r.status).toBe("installed");
  });

  it("returns 'failed' when client.pull throws", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "listModels").mockResolvedValue([]);
    vi.spyOn(client, "pull").mockRejectedValue(new Error("manifest not found"));
    const r = await ensureModelInstalled({ client, model: "missing" });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/manifest not found/);
  });

  it("forwards progress events via onProgress callback", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "listModels")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["m"]);
    vi.spyOn(client, "pull").mockImplementation(async (_m, onProgress) => {
      onProgress?.({ status: "downloading", completed: 50, total: 100 });
      onProgress?.({ status: "success" });
      return { status: "success" };
    });
    const events: any[] = [];
    await ensureModelInstalled({ client, model: "m", onProgress: (e) => events.push(e) });
    expect(events).toHaveLength(2);
  });
});

import { describe, it, expect, vi } from "vitest";
import { Embedder } from "../../src/ollama/embeddings.js";
import { OllamaClient } from "../../src/ollama/client.js";

describe("Embedder", () => {
  it("calls client.embed with the configured model", async () => {
    const client = new OllamaClient();
    const spy = vi
      .spyOn(client, "embed")
      .mockResolvedValue(new Float32Array([0.1, 0.2]));
    const e = new Embedder({ client, model: "qwen3-embedding:0.6b" });
    const v = await e.embed("hello world");
    expect(spy).toHaveBeenCalledWith({
      model: "qwen3-embedding:0.6b",
      input: "hello world",
    });
    expect(v.length).toBe(2);
  });

  it("batches multiple inputs sequentially", async () => {
    const client = new OllamaClient();
    vi.spyOn(client, "embed").mockImplementation(async ({ input }) => {
      return new Float32Array([input.length]);
    });
    const e = new Embedder({ client, model: "qwen3-embedding:0.6b" });
    const vs = await e.embedBatch(["a", "bb", "ccc"]);
    expect(vs).toHaveLength(3);
    expect(vs[0][0]).toBe(1);
    expect(vs[1][0]).toBe(2);
    expect(vs[2][0]).toBe(3);
  });
});

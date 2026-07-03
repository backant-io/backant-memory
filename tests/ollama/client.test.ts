import { describe, it, expect, afterEach, vi } from "vitest";
import { OllamaClient } from "../../src/ollama/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OllamaClient", () => {
  it("posts to /api/embed with model + input", async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: init.body as string });
      return new Response(
        JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        { status: 200 }
      );
    }) as any;

    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    const v = await client.embed({ model: "qwen3-embedding:0.6b", input: "hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/embed");
    const body = JSON.parse(calls[0].body);
    expect(body.model).toBe("qwen3-embedding:0.6b");
    expect(body.input).toBe("hello");
    expect(Array.from(v)).toEqual(Array.from(new Float32Array([0.1, 0.2, 0.3])));
  });

  it("throws on non-200 with body included", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("model not found", { status: 404 })
    ) as any;

    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    await expect(
      client.embed({ model: "missing", input: "x" })
    ).rejects.toThrow(/404.*model not found/);
  });

  it("ping returns true on /api/tags 200", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })
    ) as any;
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    expect(await client.ping()).toBe(true);
  });

  it("ping returns false on network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    expect(await client.ping()).toBe(false);
  });

  it("listModels returns model names", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3-embedding:0.6b" }, { name: "other" }] }), { status: 200 })
    ) as any;
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    expect(await client.listModels()).toEqual(["qwen3-embedding:0.6b", "other"]);
  });
});

describe("OllamaClient.pull", () => {
  it("POSTs /api/pull with model name and consumes the stream until success", async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: init.body as string });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(JSON.stringify({ status: "pulling manifest" }) + "\n"));
          controller.enqueue(enc.encode(JSON.stringify({ status: "downloading", completed: 50, total: 100 }) + "\n"));
          controller.enqueue(enc.encode(JSON.stringify({ status: "success" }) + "\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as any;

    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    const r = await client.pull("qwen3-embedding:0.6b");
    expect(r.status).toBe("success");
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/pull");
    const body = JSON.parse(calls[0].body);
    expect(body.name).toBe("qwen3-embedding:0.6b");
  });

  it("invokes onProgress for each NDJSON line", async () => {
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(JSON.stringify({ status: "downloading", completed: 25, total: 100 }) + "\n"));
          controller.enqueue(enc.encode(JSON.stringify({ status: "downloading", completed: 75, total: 100 }) + "\n"));
          controller.enqueue(enc.encode(JSON.stringify({ status: "success" }) + "\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as any;

    const events: any[] = [];
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    await client.pull("m", (e) => events.push(e));
    expect(events.length).toBe(3);
    expect(events[2].status).toBe("success");
  });

  it("throws if final status is not 'success'", async () => {
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(JSON.stringify({ error: "manifest not found" }) + "\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as any;

    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    await expect(client.pull("missing")).rejects.toThrow(/manifest not found/);
  });

  it("handles JSON lines split across chunks (NDJSON buffering)", async () => {
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          // Split one JSON object across two chunks:
          controller.enqueue(enc.encode('{"status":"down'));
          controller.enqueue(enc.encode('loading","completed":50}\n{"status":"success"}\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as any;

    const events: any[] = [];
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    await client.pull("m", (e) => events.push(e));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ status: "downloading", completed: 50 });
    expect(events[1]).toEqual({ status: "success" });
  });
});

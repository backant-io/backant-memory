import { describe, it, expect } from "vitest";
import { encodeEmbedding, decodeEmbedding, embeddingToJson } from "../../src/memory/embedding-util.js";

describe("embedding-util", () => {
  it("round-trips a Float32Array through Buffer", () => {
    const original = new Float32Array([0.1, -0.2, 0.3, 1.0, -1.0]);
    const buf = encodeEmbedding(original);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(original.length * 4);
    const decoded = decodeEmbedding(buf);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("encodes a 1024-dim vector to a 4096-byte buffer", () => {
    const v = new Float32Array(1024).fill(0.5);
    const buf = encodeEmbedding(v);
    expect(buf.length).toBe(4096);
  });

  it("embeddingToJson renders a JSON float array for vector32()", () => {
    expect(embeddingToJson(new Float32Array([0.5, -0.25]))).toBe("[0.5,-0.25]");
    expect(embeddingToJson([1, 2, 3])).toBe("[1,2,3]");
  });
});

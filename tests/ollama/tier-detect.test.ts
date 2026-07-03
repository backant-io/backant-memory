import { describe, it, expect } from "vitest";
import { suggestTier, embeddingDimForTier } from "../../src/ollama/tier-detect.js";

describe("suggestTier", () => {
  it("suggests 8b when ≥32GB RAM and has GPU/Metal", () => {
    expect(suggestTier({ totalRamGb: 64, hasMetal: true })).toBe("qwen3-embedding:8b");
    expect(suggestTier({ totalRamGb: 32, hasCuda: true })).toBe("qwen3-embedding:8b");
  });

  it("suggests 4b when ≥16GB RAM and has GPU/Metal", () => {
    expect(suggestTier({ totalRamGb: 24, hasMetal: true })).toBe("qwen3-embedding:4b");
    expect(suggestTier({ totalRamGb: 16, hasCuda: true })).toBe("qwen3-embedding:4b");
  });

  it("suggests 0.6b for low RAM or no GPU", () => {
    expect(suggestTier({ totalRamGb: 8, hasMetal: true })).toBe("qwen3-embedding:0.6b");
    expect(suggestTier({ totalRamGb: 64, hasMetal: false, hasCuda: false })).toBe(
      "qwen3-embedding:0.6b"
    );
  });

  it("exports embedding dim per tier", () => {
    expect(embeddingDimForTier("qwen3-embedding:0.6b")).toBe(1024);
    expect(embeddingDimForTier("qwen3-embedding:4b")).toBe(2560);
    expect(embeddingDimForTier("qwen3-embedding:8b")).toBe(4096);
  });
});

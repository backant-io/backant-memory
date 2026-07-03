import { describe, it, expect } from "vitest";
import { decayFactorForTier, shouldArchive, decayEdgeFactor } from "../../src/memory/decay.js";

describe("decay math", () => {
  it("stm factor is 0.7", () => {
    expect(decayFactorForTier("stm")).toBe(0.7);
  });
  it("ltm factor is 0.98", () => {
    expect(decayFactorForTier("ltm")).toBe(0.98);
  });
  it("stm archives when weight < 0.1", () => {
    expect(shouldArchive("stm", 0.05)).toBe(true);
    expect(shouldArchive("stm", 0.11)).toBe(false);
  });
  it("ltm never archives", () => {
    expect(shouldArchive("ltm", 0.01)).toBe(false);
  });
  it("edge decay factor is 0.95 normally", () => {
    expect(decayEdgeFactor({ totalEdges: 100 })).toBe(0.95);
  });
  it("edge decay factor is 0.85 when graph > 10000", () => {
    expect(decayEdgeFactor({ totalEdges: 10_001 })).toBe(0.85);
  });
});

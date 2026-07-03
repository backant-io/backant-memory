import { describe, it, expect } from "vitest";
import {
  ACTION_TYPES,
  EPISODE_OUTCOMES,
  surpriseMultiplier,
  type ActionType,
} from "../../src/memory/episodic-types.js";

describe("episodic-types", () => {
  it("exposes the closed action_type set from spec §1.2", () => {
    expect(ACTION_TYPES).toEqual([
      "fix",
      "merge",
      "implement",
      "review-feedback",
      "migrate",
      "investigate",
      "other",
    ]);
  });

  it("exposes the closed episode outcome set", () => {
    expect(EPISODE_OUTCOMES).toEqual(["success", "failure", "partial"]);
  });

  it("returns 1.0 when outcome matches the stated expectation", () => {
    // expected 'success', got 'success' → no surprise
    expect(surpriseMultiplier("success", "success")).toBe(1.0);
    // expected 'failure', got 'failure' → no surprise
    expect(surpriseMultiplier("failure", "failure")).toBe(1.0);
  });

  it("returns 2.0 when the outcome contradicts the expectation", () => {
    // expected 'success', got 'failure' → surprising
    expect(surpriseMultiplier("success", "failure")).toBe(2.0);
    // expected 'failure', got 'success' → surprising
    expect(surpriseMultiplier("failure", "success")).toBe(2.0);
  });

  it("treats 'partial' as a mismatch against either expectation (surprising)", () => {
    // 'partial' never equals 'success' or 'failure' → always 2.0
    expect(surpriseMultiplier("success", "partial")).toBe(2.0);
    expect(surpriseMultiplier("failure", "partial")).toBe(2.0);
  });

  it("narrows ActionType to the literal union", () => {
    const a: ActionType = "fix";
    expect(ACTION_TYPES.includes(a)).toBe(true);
  });
});

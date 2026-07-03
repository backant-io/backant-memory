import { describe, it, expect } from "vitest";
import {
  parseProcedure,
  serializeProcedure,
  embeddingTextFor,
  applySuccess,
  applyFailure,
  shouldPromote,
  shouldArchive,
  PROMOTION_THRESHOLD,
  ARCHIVE_FLOOR,
  ARCHIVE_MIN_APPLICATIONS,
} from "../../src/memory/procedure-content.js";
import type { ProcedureContent } from "../../src/memory/types.js";

function base(): ProcedureContent {
  return {
    name: "deploy sqld infra change",
    trigger: "when an infra/ task touches ECS or ALB",
    steps: ["run {deploy_script}", "verify {health_check}"],
    depends_on_paths: ["infra/deploy.sh"],
    validated_at_sha: "20b4375",
    status: "proposed",
    times_applied: 0,
    success_rate: null,
  };
}

describe("procedure-content", () => {
  it("round-trips parse/serialize", () => {
    const c = base();
    const round = parseProcedure(serializeProcedure(c));
    expect(round).toEqual(c);
  });

  it("parseProcedure throws on malformed JSON", () => {
    expect(() => parseProcedure("{not json")).toThrow();
  });

  it("embeddingTextFor concatenates name + trigger only (spec §3.1)", () => {
    const c = base();
    expect(embeddingTextFor(c)).toBe(
      "deploy sqld infra change\nwhen an infra/ task touches ECS or ALB"
    );
  });

  it("PROMOTION_THRESHOLD is N=2 (spec §3.2)", () => {
    expect(PROMOTION_THRESHOLD).toBe(2);
  });

  it("ARCHIVE_FLOOR is 0.5 after >=4 applications (spec §3.2)", () => {
    expect(ARCHIVE_FLOOR).toBe(0.5);
    expect(ARCHIVE_MIN_APPLICATIONS).toBe(4);
  });

  it("applySuccess: first success -> times_applied 1, success_rate 1.0", () => {
    const next = applySuccess(base());
    expect(next.times_applied).toBe(1);
    expect(next.success_rate).toBe(1);
  });

  it("applySuccess after one failure recovers the running rate", () => {
    let c = applyFailure(base());        // 0/1 -> rate 0
    expect(c.success_rate).toBe(0);
    c = applySuccess(c);                 // 1/2 -> rate 0.5
    expect(c.times_applied).toBe(2);
    expect(c.success_rate).toBe(0.5);
  });

  it("applyFailure decrements the running success_rate", () => {
    let c = applySuccess(applySuccess(base())); // 2/2 -> 1.0
    c = applyFailure(c);                          // 2/3 -> 0.666...
    expect(c.times_applied).toBe(3);
    expect(c.success_rate).toBeCloseTo(2 / 3, 5);
  });

  it("shouldPromote: proposed reaching N=2 consecutive judge-confirmed successes", () => {
    // successesSinceProposed counted by the caller; promote at >= threshold AND status promotable
    expect(shouldPromote("proposed", 2)).toBe(true);
    expect(shouldPromote("proposed", 1)).toBe(false);
    expect(shouldPromote("stale", 2)).toBe(true);   // stale promotes like proposed
    expect(shouldPromote("validated", 2)).toBe(false); // already validated
    expect(shouldPromote("archived", 9)).toBe(false);  // archived never promotes
  });

  it("shouldArchive: below floor only after >=4 applications", () => {
    expect(shouldArchive({ ...base(), times_applied: 5, success_rate: 0.4 })).toBe(true);
    expect(shouldArchive({ ...base(), times_applied: 5, success_rate: 0.5 })).toBe(false); // at floor, not below
    expect(shouldArchive({ ...base(), times_applied: 3, success_rate: 0.0 })).toBe(false); // too few applications
    expect(shouldArchive({ ...base(), times_applied: 4, success_rate: 0.49 })).toBe(true);
  });
});

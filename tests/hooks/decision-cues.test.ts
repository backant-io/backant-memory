import { describe, it, expect } from "vitest";
import { deriveDecisionCues, type TaskStateForCues } from "../../src/hooks/decision-cues.js";

describe("deriveDecisionCues", () => {
  const taskState: TaskStateForCues = {
    title: "auth methods",
    plan: [
      { step: "wire oauth callback", status: "done" },
      { step: "add session refresh", status: "active" },
      { step: "rate-limit login", status: "todo" },
    ],
    touched: [{ path: "src/auth/oauth.ts", sha: "abc" }, { path: "src/auth/session.ts", sha: "def" }],
  };

  it("emits epic title, the active plan step, and touched file basenames", () => {
    const cues = deriveDecisionCues({ taskState, boardCandidates: [] });
    expect(cues).toContain("auth methods");
    expect(cues).toContain("add session refresh");
    expect(cues).toContain("oauth.ts");
    expect(cues).toContain("session.ts");
  });

  it("includes board candidate titles", () => {
    const cues = deriveDecisionCues({
      taskState: null,
      boardCandidates: ["flaky CI on main", "PR #42 review feedback"],
    });
    expect(cues).toContain("flaky CI on main");
    expect(cues).toContain("PR #42 review feedback");
  });

  it("dedupes and drops empties, capping at 8 cues", () => {
    const cues = deriveDecisionCues({
      taskState: { title: "x", plan: [{ step: "x", status: "active" }], touched: [] },
      boardCandidates: ["x", "", "  ", "y"],
    });
    expect(cues.filter((c) => c === "x")).toHaveLength(1);
    expect(cues).not.toContain("");
    expect(cues.length).toBeLessThanOrEqual(8);
  });

  it("returns an empty array when there is neither task state nor board", () => {
    expect(deriveDecisionCues({ taskState: null, boardCandidates: [] })).toEqual([]);
  });
});

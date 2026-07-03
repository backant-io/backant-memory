import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  MemoryEntry,
  MemoryTier,
  MemoryType,
  EdgeType,
  EdgeStatus,
  Edge,
  DreamCandidate,
  CandidateVerdict,
  LtmHistory,
  ProcedureStatus,
  ProcedureContent,
} from "../../src/memory/types.js";

describe("memory types", () => {
  it("MemoryTier is 'stm' | 'ltm'", () => {
    expectTypeOf<MemoryTier>().toEqualTypeOf<"stm" | "ltm">();
  });

  it("EdgeType has all five values", () => {
    const types: EdgeType[] = ["related_to", "contradicts", "supports", "supersedes", "refines"];
    expect(types).toHaveLength(5);
  });

  it("CandidateVerdict has the four values", () => {
    const v: CandidateVerdict[] = ["ACT", "KEEP", "DISCARD", "REVISE"];
    expect(v).toHaveLength(4);
  });

  it("MemoryEntry has the required fields", () => {
    const e: MemoryEntry = {
      id: "stm_2026-05-13_abc",
      tier: "stm",
      type: "observation",
      content: "test",
      sources: ["log:2026-05-13"],
      weight: 1.0,
      created: "2026-05-13T00:00:00Z",
      last_reinforced: "2026-05-13T00:00:00Z",
      dream_citations: 0,
      act_citations: 0,
      revision_count: 0,
      embedding: null,
    };
    expect(e.id).toBe("stm_2026-05-13_abc");
  });
});

describe("procedure types", () => {
  it("procedure is an allowed MemoryType", () => {
    const t: MemoryType = "procedure";
    expect(t).toBe("procedure");
  });

  it("ProcedureStatus is the closed lifecycle set", () => {
    const all: ProcedureStatus[] = ["proposed", "validated", "stale", "archived"];
    expect(all).toHaveLength(4);
  });

  it("ProcedureContent carries the spec §3.1 fields", () => {
    const c: ProcedureContent = {
      name: "deploy sqld infra change",
      trigger: "when an infra/ task touches ECS or ALB",
      steps: ["run {deploy_script}", "verify {health_check}"],
      depends_on_paths: ["infra/deploy.sh", "infra/task-def.json"],
      validated_at_sha: "20b4375",
      status: "proposed",
      times_applied: 0,
      success_rate: null,
    };
    expect(c.steps).toHaveLength(2);
    expect(c.success_rate).toBeNull();
  });
});

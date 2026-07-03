import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryServer } from "../src/server.js";

const EXPECTED_TOOLS = [
  "memory_write_stm", "memory_write_ltm", "memory_write_episode",
  "memory_recall", "memory_recall_with_edges", "memory_recall_by_id",
  "memory_recall_by_edge", "memory_pattern_check",
  "memory_revise_ltm", "memory_reinforce", "memory_promote", "memory_demote",
  "memory_decay_sweep", "memory_bump_verdict_boost",
  "memory_edge_propose", "memory_edge_approve", "memory_edge_reject", "edges_pending",
  "task_state_write", "task_state_read",
  "procedure_propose", "procedure_outcome", "procedure_sweep", "procedure_grounding",
].sort();

describe("buildMemoryServer", () => {
  it("exposes exactly the 24 core tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-"));
    const srv = await buildMemoryServer({ workspaceCwd: dir, memoryDbPath: join(dir, "m.db") });
    expect(srv.listToolNames().sort()).toEqual(EXPECTED_TOOLS);
  });

  it("has no kairos-cycle wording in tool descriptions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bam-"));
    const srv = await buildMemoryServer({ workspaceCwd: dir, memoryDbPath: join(dir, "m.db") });
    for (const d of srv.listToolDescriptions()) {
      expect(d).not.toMatch(/wake-judge|kairos-act|kairos-retry|kairos-observe|kairos-plan-epic|dream pipeline|Dream-only/i);
    }
  });
});

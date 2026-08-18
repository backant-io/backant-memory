import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldRecallPrompt,
  cueFromPrompt,
  formatAge,
  formatPromptRecall,
  filterAlreadyInjected,
  rememberInjected,
} from "../../src/hooks/prompt-recall.js";
import type { RecallHit } from "../../src/tools/memory/recall.js";

const NOW = new Date("2026-08-18T12:00:00Z");
function hit(p: Partial<RecallHit>): RecallHit {
  return { id: "ltm_lesson_001", content: "use pnpm, not npm", weight: 1, score: 0.7, sources: [], type: "lesson", tier: "ltm",
    created: "2026-08-01T00:00:00Z", last_reinforced: "2026-08-15T00:00:00Z", ...p };
}

describe("shouldRecallPrompt", () => {
  // WHY: slash commands and one-word replies ("yes", "continue") are not cues;
  // recalling on them injects noise into every turn and burns the daemon budget.
  it("skips slash commands, empty and very short prompts", () => {
    expect(shouldRecallPrompt("/commit")).toBe(false);
    expect(shouldRecallPrompt("")).toBe(false);
    expect(shouldRecallPrompt("yes")).toBe(false);
    expect(shouldRecallPrompt("continue")).toBe(false);
  });
  it("accepts a real task prompt", () => {
    expect(shouldRecallPrompt("fix the auth token refresh bug in oauth.ts")).toBe(true);
  });
});

describe("cueFromPrompt", () => {
  it("collapses whitespace and truncates a pasted-log prompt so embedding stays cheap", () => {
    const long = "look at this\n\n" + "x".repeat(5000);
    const cue = cueFromPrompt(long);
    expect(cue.length).toBeLessThanOrEqual(600);
    expect(cue.startsWith("look at this x")).toBe(true);
  });
});

describe("formatAge", () => {
  it("renders human ages", () => {
    expect(formatAge("2026-08-18T09:00:00Z", NOW)).toBe("today");
    expect(formatAge("2026-08-15T00:00:00Z", NOW)).toBe("3d");
    expect(formatAge("2026-07-01T00:00:00Z", NOW)).toBe("6w");
    expect(formatAge("2026-01-01T00:00:00Z", NOW)).toBe("7mo");
    expect(formatAge(undefined, NOW)).toBe("?");
  });
});

describe("formatPromptRecall", () => {
  it("renders hits with tier/type/age/id and a reinforce footer; episodes are compacted", () => {
    const out = formatPromptRecall("backant-io/x", [
      hit({}),
      hit({ id: "stm_2026-08-10_ab", tier: "stm", type: "episode", last_reinforced: "2026-08-10T00:00:00Z",
        content: JSON.stringify({ situation: "migrating db", action_taken: "ran migrate", expected: "success", outcome: "failure", evidence: "SQLITE_BUSY" }) }),
    ], NOW);
    expect(out).toContain("backant-io/x");
    expect(out).toContain("[ltm · lesson · 3d]");
    expect(out).toContain("use pnpm, not npm");
    expect(out).toContain("ltm_lesson_001");
    // episode JSON is not dumped raw
    expect(out).not.toContain('"situation"');
    expect(out).toContain("migrating db");
    expect(out).toContain("outcome: failure");
    expect(out).toContain("memory_reinforce");
  });
  it("returns empty for no hits and truncates long content", () => {
    expect(formatPromptRecall("o/r", [], NOW)).toBe("");
    const out = formatPromptRecall("o/r", [hit({ content: "y".repeat(2000) })], NOW);
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("…");
  });
});

describe("per-session injected-id memory", () => {
  // WHY: the same top hits would otherwise be re-injected on every prompt of a
  // long session — the model has already seen them; repeating them is pure noise.
  it("filters ids already injected in this session and persists across calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-"));
    const first = filterAlreadyInjected(dir, "sess-1", [hit({ id: "a" }), hit({ id: "b" })]);
    expect(first.map((h) => h.id)).toEqual(["a", "b"]);
    rememberInjected(dir, "sess-1", first);
    const second = filterAlreadyInjected(dir, "sess-1", [hit({ id: "a" }), hit({ id: "c" })]);
    expect(second.map((h) => h.id)).toEqual(["c"]);
    // another session is unaffected
    expect(filterAlreadyInjected(dir, "sess-2", [hit({ id: "a" })]).map((h) => h.id)).toEqual(["a"]);
  });
});

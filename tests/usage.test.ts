import { describe, it, expect } from "vitest";
import { summarizeSessionLines, aggregateUsage, renderUsageReport } from "../src/usage.js";

const L = (o: object) => JSON.stringify(o);
const asst = (parts: object[], extra: object = {}) => L({ type: "assistant", isSidechain: false, entrypoint: "cli", message: { content: parts }, timestamp: "2026-08-18T10:00:00Z", ...extra });
const user = (t: string, entry = "cli") => L({ type: "user", isSidechain: false, entrypoint: entry, message: { content: t } });
const tool = (name: string, input: object = {}) => ({ type: "tool_use", name, input });

function session(nTurns: number, withMemory: boolean, entry = "cli"): string[] {
  const lines = [user("do the thing", entry), L({ type: "attachment", entrypoint: entry, attachment: { type: "hook_success", hookName: "SessionStart:startup", stdout: withMemory ? "## Project memory — o/r" : "" } })];
  for (let i = 0; i < nTurns; i++) lines.push(asst([tool("Bash", { command: "ls" })], { entrypoint: entry }));
  if (withMemory) {
    lines.push(asst([tool("ToolSearch", { query: "select:mcp__backant-memory__memory_recall" })], { entrypoint: entry }));
    lines.push(asst([tool("mcp__backant-memory__memory_recall", { cue: "x" })], { entrypoint: entry }));
    lines.push(asst([tool("mcp__backant-memory__memory_write_ltm", {})], { entrypoint: entry }));
  }
  // sidechain noise
  lines.push(L({ type: "assistant", isSidechain: true, message: { content: [tool("mcp__backant-memory__memory_recall")] } }));
  return lines;
}

describe("summarizeSessionLines", () => {
  it("counts turns, memory calls by name, ToolSearch-for-memory, hook + digest presence; ignores sidechains", () => {
    const s = summarizeSessionLines(session(12, true), "proj-a");
    expect(s.entrypoint).toBe("cli");
    expect(s.assistantTurns).toBe(15);
    expect(s.memoryCalls).toEqual({ memory_recall: 1, memory_write_ltm: 1 });
    expect(s.toolSearchMemory).toBe(1);
    expect(s.sessionStartHook).toBe(true);
    expect(s.digestInjected).toBe(true);
    expect(s.userPrompts).toBe(1);
  });
});

describe("aggregateUsage", () => {
  // WHY: adoption must be measured, not inferred from store size — this is the
  // table that revealed 91% of sessions were automation with no MCP at all.
  it("splits by entrypoint, applies the min-turns filter, and computes calls per 1k turns", () => {
    const sessions = [
      summarizeSessionLines(session(12, true), "a"),
      summarizeSessionLines(session(20, false), "a"),
      summarizeSessionLines(session(3, false), "a"),              // trivial → excluded
      summarizeSessionLines(session(30, false, "sdk-py"), "b"),
    ];
    const r = aggregateUsage(sessions, { minTurns: 10 });
    expect(r.totalSessions).toBe(3);
    const cli = r.byEntrypoint.find((e) => e.entrypoint === "cli")!;
    expect(cli.sessions).toBe(2);
    expect(cli.usedMemory).toBe(1);
    expect(cli.digestInjected).toBe(1);
    expect(cli.hookSeen).toBe(2);
    const sdk = r.byEntrypoint.find((e) => e.entrypoint === "sdk-py")!;
    expect(sdk.sessions).toBe(1);
    expect(sdk.usedMemory).toBe(0);
    expect(r.memoryCallsByName.memory_recall).toBe(1);
    // 2 memory calls over (15+20+30)=65 assistant turns → ~30.8 per 1k
    expect(r.callsPer1kTurns).toBeCloseTo(30.8, 1);
    const text = renderUsageReport(r);
    expect(text).toContain("cli");
    expect(text).toContain("sdk-py");
    expect(text).toContain("per 1k assistant turns");
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizeTranscript,
  renderSessionSummary,
  sessionSummaryId,
  upsertSessionSummary,
  readLatestSessionSummary,
} from "../../src/hooks/session-summary.js";
import { openMemoryDb } from "../../src/memory/libsql-db.js";
import type { Embedder } from "../../src/ollama/embeddings.js";

const fakeEmbedder = { embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]) } as unknown as Embedder;

function line(o: object): string { return JSON.stringify(o); }
const user = (text: string) => line({ type: "user", isSidechain: false, message: { role: "user", content: text }, timestamp: "2026-08-18T10:00:00Z", gitBranch: "feat/x", cwd: "/repo" });
const toolResult = () => line({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const assistant = (parts: object[]) => line({ type: "assistant", isSidechain: false, message: { role: "assistant", content: parts }, timestamp: "2026-08-18T10:05:00Z" });
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string, input: object) => ({ type: "tool_use", id: "t", name, input });

function transcript(nTurns = 8): string[] {
  const out = [user("fix the auth token refresh bug in oauth.ts")];
  for (let i = 0; i < nTurns; i++) {
    out.push(assistant([tool("Edit", { file_path: "/repo/src/auth/oauth.ts", old_string: "a", new_string: "b" })]));
    out.push(toolResult());
  }
  out.push(assistant([tool("mcp__backant-memory__memory_recall", { cue: "auth" })]));
  out.push(toolResult());
  out.push(assistant([tool("Write", { file_path: "/repo/tests/auth.test.ts", content: "x" })]));
  out.push(toolResult());
  out.push(user("also run the tests"));
  out.push(assistant([tool("Bash", { command: "npm test" })]));
  out.push(toolResult());
  out.push(assistant([text("Done: refresh now retries once on 401; tests green.")]));
  // sidechain noise must be ignored
  out.push(line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [text("subagent chatter")] } }));
  return out;
}

describe("summarizeTranscript", () => {
  it("extracts prompts, touched files, final outcome, branch and memory-op count; ignores tool results and sidechains", () => {
    const s = summarizeTranscript(transcript(), { sessionId: "s1", reason: "prompt_input_exit" });
    expect(s).not.toBeNull();
    expect(s!.prompts).toEqual(["fix the auth token refresh bug in oauth.ts", "also run the tests"]);
    expect(s!.touched).toEqual(["/repo/src/auth/oauth.ts", "/repo/tests/auth.test.ts"]);
    expect(s!.lastAssistantText).toBe("Done: refresh now retries once on 401; tests green.");
    expect(s!.branch).toBe("feat/x");
    expect(s!.memoryOps).toBe(1);
    expect(s!.assistantTurns).toBe(12);
    const rendered = renderSessionSummary(s!, "backant-io/x");
    expect(rendered).toContain("backant-io/x@feat/x");
    expect(rendered).toContain("oauth.ts");
    expect(rendered).toContain("tests green");
    expect(rendered).not.toContain("subagent chatter");
    expect(rendered.length).toBeLessThan(1500);
  });

  it("returns null for trivial sessions so the store is not filled with one-liners", () => {
    // WHY: a session with two turns and no edits teaches nothing worth recalling.
    expect(summarizeTranscript([user("hi there, quick question"), assistant([text("hello")])], { sessionId: "s2", reason: "other" })).toBeNull();
  });
});

describe("upsertSessionSummary", () => {
  it("is idempotent per session (PreCompact then SessionEnd → one row, newest content) and readable as latest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    const db = await openMemoryDb({ localPath: join(dir, "m.db"), repo: "o/r" });
    const id = sessionSummaryId("2026-08-18T10:00:00Z", "sess-abc");
    expect(id.startsWith("stm_2026-08-18_ss")).toBe(true);
    await upsertSessionSummary({ db, embedder: fakeEmbedder, sessionId: "sess-abc", event: "PreCompact", content: "first version", now: () => new Date("2026-08-18T10:00:00Z") });
    await upsertSessionSummary({ db, embedder: fakeEmbedder, sessionId: "sess-abc", event: "SessionEnd", content: "second version", now: () => new Date("2026-08-18T11:00:00Z") });
    const rows = await db.all<{ id: string; content: string; type: string; tier: string }>("SELECT id, content, type, tier FROM memory");
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("session_summary");
    expect(rows[0].tier).toBe("stm");
    expect(rows[0].content).toBe("second version");
    const fts = await db.all<{ content: string }>("SELECT content FROM memory_fts");
    expect(fts.length).toBe(1);
    expect(fts[0].content).toBe("second version");
    const latest = await readLatestSessionSummary(db);
    expect(latest?.content).toBe("second version");
    await db.close();
  });
});

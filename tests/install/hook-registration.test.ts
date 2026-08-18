import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHook, unregisterHook } from "../../src/install/hook-registration.js";

describe("registerHook", () => {
  it("appends a SessionStart hook once, preserves existing hooks, removable", () => {
    const f = join(mkdtempSync(join(tmpdir(), "hk-")), "settings.json");
    writeFileSync(f, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }] } }));
    registerHook(f, "node /g/dist/hooks/session-start-recall.js");
    registerHook(f, "node /g/dist/hooks/session-start-recall.js");   // idempotent
    let j = JSON.parse(readFileSync(f, "utf8"));
    const all = JSON.stringify(j.hooks.SessionStart);
    expect(all).toContain("existing");
    expect(all.split("session-start-recall").length).toBe(2);        // exactly one occurrence
    unregisterHook(f, "session-start-recall");
    j = JSON.parse(readFileSync(f, "utf8"));
    expect(JSON.stringify(j.hooks.SessionStart)).not.toContain("session-start-recall");
    expect(JSON.stringify(j.hooks.SessionStart)).toContain("existing");
  });

  it("registers under an explicit event with a per-hook timeout, and unregister sweeps every event", () => {
    // WHY: adoption depends on hooks that fire mid-session (UserPromptSubmit) and
    // at the end (SessionEnd/PreCompact), not only SessionStart. SessionEnd's
    // default budget is 1.5s total, so the entry must be able to carry a timeout.
    const f = join(mkdtempSync(join(tmpdir(), "hk-")), "settings.json");
    registerHook(f, "node /g/dist/hooks/prompt-recall.js", { event: "UserPromptSubmit" });
    registerHook(f, "node /g/dist/hooks/session-summary.js", { event: "SessionEnd", timeout: 20 });
    registerHook(f, "node /g/dist/hooks/session-summary.js", { event: "PreCompact", timeout: 20 });
    registerHook(f, "node /g/dist/hooks/session-summary.js", { event: "PreCompact", timeout: 20 }); // idempotent
    let j = JSON.parse(readFileSync(f, "utf8"));
    expect(JSON.stringify(j.hooks.UserPromptSubmit)).toContain("prompt-recall");
    expect(j.hooks.SessionEnd[0].hooks[0].timeout).toBe(20);
    expect(JSON.stringify(j.hooks.PreCompact).split("session-summary").length).toBe(2);
    expect(j.hooks.SessionStart).toBeUndefined();

    unregisterHook(f, "session-summary");   // no event given → every event
    j = JSON.parse(readFileSync(f, "utf8"));
    expect(j.hooks.SessionEnd).toBeUndefined();
    expect(j.hooks.PreCompact).toBeUndefined();
    expect(JSON.stringify(j.hooks.UserPromptSubmit)).toContain("prompt-recall");
  });
});

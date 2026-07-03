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
});

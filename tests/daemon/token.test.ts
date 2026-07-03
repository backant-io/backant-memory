import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken } from "../../src/daemon/token.js";

describe("ensureToken", () => {
  it("creates a 64-hex-char token with 0600 perms, and is idempotent", () => {
    const p = join(mkdtempSync(join(tmpdir(), "tok-")), "token");
    const t1 = ensureToken(p);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(ensureToken(p)).toBe(t1);
    expect(readFileSync(p, "utf8").trim()).toBe(t1);
  });
});

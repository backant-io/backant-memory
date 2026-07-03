import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertManagedBlock, removeManagedBlock } from "../../src/install/claude-md.js";

const p = () => join(mkdtempSync(join(tmpdir(), "cmd-")), "CLAUDE.md");

describe("upsertManagedBlock", () => {
  it("creates the file when absent", () => {
    const f = p();
    upsertManagedBlock(f, "USE MEMORY");
    expect(readFileSync(f, "utf8")).toBe("<!-- backant-memory:start -->\nUSE MEMORY\n<!-- backant-memory:end -->\n");
  });
  it("byte-preserves user content outside markers, replaces inside, idempotent", () => {
    const f = p();
    const user = "# My rules\n\ndo not touch\n";
    writeFileSync(f, user);
    upsertManagedBlock(f, "v1");
    upsertManagedBlock(f, "v2");
    const out = readFileSync(f, "utf8");
    expect(out.startsWith(user)).toBe(true);
    expect(out).toContain("v2");
    expect(out).not.toContain("v1");
    upsertManagedBlock(f, "v2");
    expect(readFileSync(f, "utf8")).toBe(out);
  });
  it("removeManagedBlock restores the original bytes", () => {
    const f = p();
    const user = "keep me\n";
    writeFileSync(f, user);
    upsertManagedBlock(f, "x");
    removeManagedBlock(f);
    expect(readFileSync(f, "utf8")).toBe(user);
  });
});

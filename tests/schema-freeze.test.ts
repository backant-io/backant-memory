import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Schema freeze (spec 2026-07-03-standalone-memory-mcp-design.md §9):
// backant-memory and backant-kairos share DB files. Neither repo may change
// the schema until backant-kairos consumes the backant-memory package.
const PIN = "33fc94f3d5f612bd768f86536033fb7fdf5ddc51c5013a30f49a34e2627bd68f";

describe("schema freeze", () => {
  it("schema.sql is byte-identical to the frozen extraction-time schema", () => {
    const sha = createHash("sha256").update(readFileSync(new URL("../src/memory/schema.sql", import.meta.url))).digest("hex");
    expect(sha).toBe(PIN);
  });
});

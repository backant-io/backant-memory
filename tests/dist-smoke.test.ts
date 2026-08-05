import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DIST = join(process.cwd(), "dist");

/**
 * Proves the SHIPPED artifact, not the source tree: the four subpath bundles
 * exist with declarations, and a bundle can open a store from its own
 * directory (migrations resolved via import.meta.url from node_modules).
 *
 * Unguarded on purpose. `npm test` runs `pretest` → `npm run build` first, so
 * dist/ is always freshly built here; a missing or broken build must fail this
 * suite loudly rather than skip it into a false green.
 */
describe("dist smoke", () => {
  it("emits all four entry bundles with type declarations", () => {
    for (const rel of [
      "index.js", "index.d.ts",
      "tools/index.js", "tools/index.d.ts",
      "docker/index.js", "docker/index.d.ts",
      "ollama/index.js", "ollama/index.d.ts",
      "cli.js", "hooks/session-start-recall.js", "postinstall.js",
    ]) {
      expect(existsSync(join(DIST, rel)), `dist/${rel} must exist`).toBe(true);
    }
  });

  it("ships migrations adjacent to every store-opening bundle", () => {
    for (const dir of ["migrations", "hooks/migrations", "tools/migrations"]) {
      expect(existsSync(join(DIST, dir, "000-baseline.sql")), `dist/${dir} must exist`).toBe(true);
    }
    expect(existsSync(join(DIST, "schema.sql"))).toBe(false);
  });

  it("the built engine opens a store and stamps the ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-dist-"));
    try {
      const script =
        `const {openMemoryDb}=await import(${JSON.stringify(join(DIST, "index.js"))});` +
        `const db=await openMemoryDb({localPath:${JSON.stringify(join(dir, "mem.db"))}});` +
        `const r=await db.all("SELECT name FROM schema_migrations");` +
        `console.log(JSON.stringify(r.map(x=>x.name)));await db.close();`;
      const out = execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
      expect(JSON.parse(out.trim())).toContain("000-baseline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

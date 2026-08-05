import { describe, it, expect } from "vitest";
import { loadMigrations } from "../../src/memory/migrations.js";

/**
 * Append-only chain test — the lawful successor to the sha256 schema freeze.
 *
 * Every SHIPPED migration is pinned by sha256. Editing a shipped migration
 * fails CI (a store already stamped with it can never be re-migrated).
 * APPENDING a migration is legal: add its { name, sha256 } to CHAIN in the
 * same PR that adds the .sql file.
 */
const CHAIN: { name: string; sha256: string }[] = [
  { name: "000-baseline", sha256: "33fc94f3d5f612bd768f86536033fb7fdf5ddc51c5013a30f49a34e2627bd68f" },
];

describe("migration chain (append-only)", () => {
  it("ships exactly the pinned migrations, in order", () => {
    expect(loadMigrations().map((m) => m.name)).toEqual(CHAIN.map((c) => c.name));
  });

  it("every shipped migration is byte-identical to its pin", () => {
    const shipped = loadMigrations();
    for (const pin of CHAIN) {
      const m = shipped.find((s) => s.name === pin.name);
      expect(m, `migration ${pin.name} is missing — shipped migrations may never be removed`).toBeDefined();
      expect(
        m!.sha256,
        `migration ${pin.name} was EDITED. Shipped migrations are immutable: append a new ` +
          `NNN-*.sql instead and add its pin to CHAIN.`
      ).toBe(pin.sha256);
    }
  });

  it("names sort in apply order and are uniquely numbered", () => {
    const names = loadMigrations().map((m) => m.name);
    expect([...names].sort()).toEqual(names);
    const ordinals = names.map((n) => n.slice(0, 3));
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });
});

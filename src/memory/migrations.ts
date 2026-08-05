import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shipped migration chain. Resolved next to THIS module so the same code works
 * from source (src/memory/migrations/) and from any tsup bundle (dist/migrations/,
 * dist/hooks/migrations/, …) — the pattern schema.sql used before it.
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface Migration {
  /** File name without ".sql", e.g. "000-baseline". Lexicographic sort = apply order. */
  name: string;
  sql: string;
  sha256: string;
}

/** Load the shipped chain, ordered. Throws if the directory is missing (a broken build). */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return {
        name: file.slice(0, -".sql".length),
        sql,
        sha256: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

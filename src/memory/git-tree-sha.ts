import { execFileSync } from "node:child_process";

/**
 * Current git blob SHA for a repo-relative path, reflecting uncommitted working-tree
 * edits (via `git hash-object` on the working file), so drift is detected the moment a
 * dependency changes — not only after commit. Returns null if the path does not exist
 * or `cwd` is not a git repo. Mirrors the execFileSync pattern in repo-identity.ts:39.
 */
export function treeShaForPath(cwd: string, path: string): string | null {
  // Hardening: depends_on_paths entries are agent-supplied. Reject flag-like paths and
  // pass `--` so git never interprets a path as an option (argv flag-smuggling). A
  // rejected path returns null → digestForPaths records it as MISSING (i.e. drift),
  // which is the safe direction.
  if (path.startsWith("-")) return null;
  try {
    return execFileSync("git", ["hash-object", "--", path], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Composite digest of the current SHAs of `paths` (in given order). A missing path
 * contributes the literal "MISSING" so deletion registers as drift.
 *
 * Single source of truth for the procedure dependency digest: both the producer
 * (`procedure_propose`, at write time) and the consumer (`procedureSweep`) compute
 * `validated_at_sha` through this one function, so a procedure proposed with a fresh
 * digest cannot be marked stale on its first sweep without real drift.
 */
export function digestForPaths(cwd: string, paths: string[]): string {
  return paths.map((p) => `${p}:${treeShaForPath(cwd, p) ?? "MISSING"}`).join("|");
}

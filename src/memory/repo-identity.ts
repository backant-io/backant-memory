import { execFileSync } from "node:child_process";

export interface RepoIdentity {
  owner: string;
  repo: string;
  /** "owner/repo" — stamped on every row. */
  repoKey: string;
  /** libSQL namespace (one per owner). */
  namespace: string;
  /** True when there is no git origin: local-only, never provisions a remote. */
  isLocalOnly: boolean;
}

/** Parse a GitHub remote URL into owner/repo identity, or null if unparseable. */
export function parseOriginUrl(url: string): Omit<RepoIdentity, "isLocalOnly"> | null {
  const cleaned = url
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  const m = cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  return { owner, repo, repoKey: `${owner}/${repo}`, namespace: sanitizeNamespace(owner) };
}

/** libSQL namespace charset is [a-zA-Z0-9_-]; map anything else to '-'. */
export function sanitizeNamespace(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Read `git remote get-url origin` for a directory, or null if none / not a repo. */
export function readOrigin(cwd: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const LOCAL: RepoIdentity = {
  owner: "",
  repo: "",
  repoKey: "__local__",
  namespace: "__local__",
  isLocalOnly: true,
};

export function deriveIdentity(originUrl: string | null): RepoIdentity {
  const parsed = originUrl ? parseOriginUrl(originUrl) : null;
  if (!parsed) return LOCAL;
  return { ...parsed, isLocalOnly: false };
}

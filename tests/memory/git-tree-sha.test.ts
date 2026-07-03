import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { treeShaForPath } from "../../src/memory/git-tree-sha.js";

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "kairos-git-sha-"));
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@t.io");
  git(d, "config", "user.name", "t");
  return d;
}

describe("treeShaForPath", () => {
  it("returns a stable blob SHA for a committed file", () => {
    dir = initRepo();
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "infra/deploy.sh"), "echo deploy\n");
    git(dir, "add", "infra/deploy.sh");
    git(dir, "commit", "-q", "-m", "add deploy");
    const a = treeShaForPath(dir, "infra/deploy.sh");
    const b = treeShaForPath(dir, "infra/deploy.sh");
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("changes when the file content changes (committed)", () => {
    dir = initRepo();
    writeFileSync(join(dir, "f.txt"), "v1\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "-m", "v1");
    const s1 = treeShaForPath(dir, "f.txt");
    writeFileSync(join(dir, "f.txt"), "v2\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "-m", "v2");
    const s2 = treeShaForPath(dir, "f.txt");
    expect(s2).not.toBe(s1);
  });

  it("reflects uncommitted working-tree edits (drift before commit)", () => {
    dir = initRepo();
    writeFileSync(join(dir, "f.txt"), "v1\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "-m", "v1");
    const s1 = treeShaForPath(dir, "f.txt");
    writeFileSync(join(dir, "f.txt"), "edited\n");
    const s2 = treeShaForPath(dir, "f.txt");
    expect(s2).not.toBe(s1);
  });

  it("returns null for a path that does not exist", () => {
    dir = initRepo();
    expect(treeShaForPath(dir, "nope/missing.ts")).toBeNull();
  });

  it("returns null when cwd is not a git repo", () => {
    dir = mkdtempSync(join(tmpdir(), "kairos-nogit-"));
    expect(treeShaForPath(dir, "anything.ts")).toBeNull();
  });

  it("rejects flag-like paths so git cannot interpret them as options (argv hardening)", () => {
    dir = initRepo();
    // A path beginning with "-" must never reach git as a bare arg (flag smuggling);
    // it returns null, which digestForPaths records as MISSING (safe = drift).
    expect(treeShaForPath(dir, "--upload-pack=touch /tmp/pwn")).toBeNull();
    expect(treeShaForPath(dir, "-rf")).toBeNull();
  });
});

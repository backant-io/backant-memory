import { describe, it, expect } from "vitest";
import { parseOriginUrl, deriveIdentity, sanitizeNamespace } from "../../src/memory/repo-identity.js";

describe("parseOriginUrl", () => {
  it("parses ssh remotes", () => {
    expect(parseOriginUrl("git@github.com:backant-io/backant-send.git")).toEqual({
      owner: "backant-io",
      repo: "backant-send",
      repoKey: "backant-io/backant-send",
      namespace: "backant-io",
    });
  });

  it("parses https remotes without .git", () => {
    expect(parseOriginUrl("https://github.com/backant-io/backant-send")).toEqual({
      owner: "backant-io",
      repo: "backant-send",
      repoKey: "backant-io/backant-send",
      namespace: "backant-io",
    });
  });

  it("sanitizes owner into a libSQL-safe namespace", () => {
    expect(parseOriginUrl("git@github.com:My.Org/Repo.git")!.namespace).toBe("My-Org");
  });

  it("returns null when no origin", () => {
    expect(parseOriginUrl("")).toBeNull();
    expect(parseOriginUrl("not-a-url")).toBeNull();
  });
});

describe("sanitizeNamespace", () => {
  it("maps disallowed chars to '-'", () => {
    expect(sanitizeNamespace("a.b/c d")).toBe("a-b-c-d");
  });
});

describe("deriveIdentity", () => {
  it("falls back to __local__ when origin is missing", () => {
    const id = deriveIdentity(null);
    expect(id.namespace).toBe("__local__");
    expect(id.repoKey).toBe("__local__");
    expect(id.isLocalOnly).toBe(true);
  });

  it("is remote for a real origin", () => {
    const id = deriveIdentity("git@github.com:backant-io/backant-send.git");
    expect(id.isLocalOnly).toBe(false);
    expect(id.namespace).toBe("backant-io");
  });
});

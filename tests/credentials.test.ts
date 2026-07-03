import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveCredentials, loadCredentials, deleteCredentials } from "../src/auth/credentials.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kairos-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("credentials", () => {
  it("saves and loads credentials", () => {
    const creds = { access_token: "test_token", client_id: "test_client" };
    saveCredentials(creds, tempDir);
    const loaded = loadCredentials(tempDir);
    expect(loaded).toEqual(creds);
  });

  it("returns null when no credentials exist", () => {
    const loaded = loadCredentials(tempDir);
    expect(loaded).toBeNull();
  });

  it("deletes credentials", () => {
    saveCredentials({ access_token: "test", client_id: "test" }, tempDir);
    deleteCredentials(tempDir);
    const loaded = loadCredentials(tempDir);
    expect(loaded).toBeNull();
  });
});

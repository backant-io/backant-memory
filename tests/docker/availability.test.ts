import { describe, it, expect, vi } from "vitest";
import { isDockerAvailable } from "../../src/docker/availability.js";

describe("isDockerAvailable", () => {
  it("returns true when `docker --version` exits 0", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "Docker version 27.0.0\n", stderr: "" }));
    expect(await isDockerAvailable({ exec })).toBe(true);
    expect(exec).toHaveBeenCalledWith("docker", ["--version"]);
  });

  it("returns false when the binary is not installed", async () => {
    const exec = vi.fn(async () => { throw new Error("ENOENT: docker"); });
    expect(await isDockerAvailable({ exec })).toBe(false);
  });

  it("returns false when daemon is unreachable (exit != 0)", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "Cannot connect" }));
    expect(await isDockerAvailable({ exec })).toBe(false);
  });
});

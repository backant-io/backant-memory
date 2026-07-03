import { describe, it, expect, vi } from "vitest";
import {
  ensureOllamaImage,
  containerState,
  ensureOllamaContainer,
  CONTAINER_NAME,
  IMAGE_NAME,
} from "../../src/docker/ollama-container.js";

describe("ensureOllamaImage", () => {
  it("pulls the image when missing", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args[0] === "image" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "pull") return { code: 0, stdout: "Status: Downloaded\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await ensureOllamaImage({ exec });
    expect(r.status).toBe("pulled");
    expect(calls.some((c) => c.args[0] === "pull" && c.args[1] === IMAGE_NAME)).toBe(true);
  });

  it("is a no-op when image already present", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await ensureOllamaImage({ exec });
    expect(r.status).toBe("already_present");
  });
});

describe("containerState", () => {
  it("returns 'running' when ps lists the container", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: `${CONTAINER_NAME}\n`,
      stderr: "",
    }));
    expect((await containerState({ exec })).state).toBe("running");
  });

  it("returns 'stopped' when ps -a lists but ps does not", async () => {
    let call = 0;
    const exec = vi.fn(async () => {
      call++;
      if (call === 1) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: `${CONTAINER_NAME}\n`, stderr: "" };
    });
    expect((await containerState({ exec })).state).toBe("stopped");
  });

  it("returns 'missing' when ps -a does not list it", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect((await containerState({ exec })).state).toBe("missing");
  });
});

describe("ensureOllamaContainer", () => {
  it("creates and starts when missing", async () => {
    const calls: { args: string[] }[] = [];
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "run") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await ensureOllamaContainer({ exec, modelsVolumePath: "/tmp/mod" });
    expect(r.action).toBe("created");
    expect(calls.some((c) => c.args[0] === "run")).toBe(true);
  });

  it("starts an existing stopped container", async () => {
    let call = 0;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      call++;
      if (args[0] === "ps" && !args.includes("-a")) return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "ps" &&  args.includes("-a")) return { code: 0, stdout: `${CONTAINER_NAME}\n`, stderr: "" };
      if (args[0] === "start") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await ensureOllamaContainer({ exec, modelsVolumePath: "/tmp/mod" });
    expect(r.action).toBe("started");
  });

  it("is a no-op when already running", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") return { code: 0, stdout: `${CONTAINER_NAME}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const r = await ensureOllamaContainer({ exec, modelsVolumePath: "/tmp/mod" });
    expect(r.action).toBe("already_running");
  });
});

import { totalmem } from "node:os";
import { execFileSync } from "node:child_process";

export type Tier = "qwen3-embedding:0.6b" | "qwen3-embedding:4b" | "qwen3-embedding:8b";

export interface HardwareInfo {
  totalRamGb: number;
  hasMetal?: boolean;
  hasCuda?: boolean;
}

export function suggestTier(hw: HardwareInfo): Tier {
  const hasAccel = (hw.hasMetal ?? false) || (hw.hasCuda ?? false);
  if (!hasAccel) return "qwen3-embedding:0.6b";
  if (hw.totalRamGb >= 32) return "qwen3-embedding:8b";
  if (hw.totalRamGb >= 16) return "qwen3-embedding:4b";
  return "qwen3-embedding:0.6b";
}

export function detectHardware(): HardwareInfo {
  const totalRamGb = Math.round(totalmem() / (1024 ** 3));
  let hasMetal = false;
  let hasCuda = false;
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
      }).trim();
      hasMetal = out === "1";
    } else if (process.platform === "linux") {
      execFileSync("nvidia-smi", ["-L"], { stdio: "ignore" });
      hasCuda = true;
    }
  } catch {
    // no accelerator available
  }
  return { totalRamGb, hasMetal, hasCuda };
}

export function embeddingDimForTier(tier: Tier): number {
  switch (tier) {
    case "qwen3-embedding:0.6b": return 1024;
    case "qwen3-embedding:4b":   return 2560;
    case "qwen3-embedding:8b":   return 4096;
  }
}

import { mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

export function installSkill(skillsDir: string, assetDir: string): void {
  const dst = join(skillsDir, "backant-memory");
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(assetDir, "skills/backant-memory/SKILL.md"), join(dst, "SKILL.md"));
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function registerHook(settingsPath: string, command: string): void {
  const j = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  j.hooks = j.hooks ?? {};
  j.hooks.SessionStart = j.hooks.SessionStart ?? [];
  const present = JSON.stringify(j.hooks.SessionStart).includes(command);
  if (!present) j.hooks.SessionStart.push({ hooks: [{ type: "command", command }] });
  writeFileSync(settingsPath, JSON.stringify(j, null, 2) + "\n");
}

export function unregisterHook(settingsPath: string, commandSubstring: string): void {
  if (!existsSync(settingsPath)) return;
  const j = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!j.hooks?.SessionStart) return;
  j.hooks.SessionStart = j.hooks.SessionStart
    .map((entry: any) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h: any) => !String(h.command ?? "").includes(commandSubstring)) }))
    .filter((entry: any) => entry.hooks.length > 0);
  writeFileSync(settingsPath, JSON.stringify(j, null, 2) + "\n");
}

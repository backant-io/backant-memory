import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreCompact" | "SessionEnd";

export interface RegisterHookOptions {
  /** Claude Code hook event to register under. Default: SessionStart. */
  event?: HookEvent;
  /** Per-hook timeout in seconds. SessionEnd's default budget is 1.5s total, so
   *  hooks that do real work must declare one (Claude Code caps at 60). */
  timeout?: number;
}

export function registerHook(settingsPath: string, command: string, opts: RegisterHookOptions = {}): void {
  const event = opts.event ?? "SessionStart";
  const j = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  j.hooks = j.hooks ?? {};
  j.hooks[event] = j.hooks[event] ?? [];
  const present = JSON.stringify(j.hooks[event]).includes(command);
  if (!present) {
    const hook: Record<string, unknown> = { type: "command", command };
    if (opts.timeout !== undefined) hook.timeout = opts.timeout;
    j.hooks[event].push({ hooks: [hook] });
  }
  writeFileSync(settingsPath, JSON.stringify(j, null, 2) + "\n");
}

/** Remove every hook whose command contains `commandSubstring` from `event`, or
 *  from every event when `event` is omitted. Empty event arrays are dropped. */
export function unregisterHook(settingsPath: string, commandSubstring: string, event?: HookEvent): void {
  if (!existsSync(settingsPath)) return;
  const j = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!j.hooks) return;
  const events = event ? [event] : Object.keys(j.hooks);
  for (const ev of events) {
    if (!Array.isArray(j.hooks[ev])) continue;
    j.hooks[ev] = j.hooks[ev]
      .map((entry: any) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h: any) => !String(h.command ?? "").includes(commandSubstring)) }))
      .filter((entry: any) => entry.hooks.length > 0);
    if (j.hooks[ev].length === 0) delete j.hooks[ev];
  }
  writeFileSync(settingsPath, JSON.stringify(j, null, 2) + "\n");
}

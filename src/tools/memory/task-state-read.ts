import type { MemoryDb } from "../../memory/libsql-db.js";
import type { TaskStateContent } from "../../memory/episodic-types.js";
import { taskStateId } from "./task-state-write.js";

export interface TaskStateReadInput {
  /** When set, read that one epic. When omitted, list all active epics. */
  epic_id?: string;
}

export interface TaskStateReadDeps {
  db: MemoryDb;
  repo?: string;
  input: TaskStateReadInput;
}

/**
 * Read task_state (spec §1.1). With epic_id → that epic's parsed content
 * (state=null if absent). Without epic_id → all currently-active epics
 * (used by the handoff assembler and observe).
 *
 * The single-epic id is rebuilt with {@link taskStateId} so it targets the same
 * (repo, epic)-scoped row the writer produced (the key folds in the sanitized
 * repo to avoid cross-repo collisions under a shared owner namespace).
 */
export async function taskStateRead(deps: TaskStateReadDeps): Promise<{
  state: TaskStateContent | null;
  active: TaskStateContent[];
}> {
  const repo = deps.repo ?? deps.db.repo;

  if (deps.input.epic_id) {
    const row = await deps.db.get<{ content: string }>(
      "SELECT content FROM memory WHERE repo = ? AND type = 'task_state' AND id = ?",
      [repo, taskStateId(repo, deps.input.epic_id)]
    );
    return { state: row ? (JSON.parse(row.content) as TaskStateContent) : null, active: [] };
  }

  const rows = await deps.db.all<{ content: string }>(
    "SELECT content FROM memory WHERE repo = ? AND type = 'task_state' ORDER BY last_reinforced DESC",
    [repo]
  );
  const active = rows
    .map((r) => JSON.parse(r.content) as TaskStateContent)
    .filter((s) => s.status === "active");
  return { state: null, active };
}

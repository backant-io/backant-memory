import type { MemoryDb } from "./libsql-db.js";
import type { HandoffBriefContent } from "./episodic-types.js";

/** Read the most recent handoff brief for a repo, or null if none exists. */
export async function readLatestHandoffBrief(
  db: MemoryDb,
  repo?: string
): Promise<HandoffBriefContent | null> {
  const r = repo ?? db.repo;
  const row = await db.get<{ content: string }>(
    "SELECT content FROM memory WHERE repo = ? AND type = 'handoff_brief' ORDER BY id DESC LIMIT 1",
    [r]
  );
  return row ? (JSON.parse(row.content) as HandoffBriefContent) : null;
}

/**
 * Render the daemon-assembled handoff brief as the FIRST injected section of
 * the session-start digest. Empty string for a 'none' or null brief, so a repo
 * with no active epic injects nothing extra.
 */
export function buildHandoffSection(brief: HandoffBriefContent | null): string {
  if (!brief || brief.active_epic === "none") return "";
  const lines: string[] = [
    `## Handoff — resume here`,
    "",
    `**Active epic:** ${brief.active_epic}`,
    `**Last completed:** ${brief.last_completed_step || "(none)"}`,
    `**Next action:** ${brief.next_action || "(decide)"}`,
  ];
  if (brief.working_set.length > 0) {
    lines.push(`**Working set:** ${brief.working_set.map((w) => `${w.path}@${w.sha}`).join(", ")}`);
  }
  if (brief.blockers.length > 0) {
    lines.push(`**Blockers:** ${brief.blockers.join("; ")}`);
  }
  if (brief.do_not_redo.length > 0) {
    lines.push("", "**Do NOT redo (already tried):**", ...brief.do_not_redo.map((d) => `- ${d}`));
  }
  return lines.join("\n");
}

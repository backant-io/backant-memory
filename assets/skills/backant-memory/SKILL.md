---
name: backant-memory
description: Use when starting work on any task with possible history (recall first), after completing or failing an attempt (write episode), after verifying durable knowledge (write LTM), or when a repeatable runbook emerges (propose procedure). Covers all mcp__backant-memory__* tools.
---

# backant-memory — persistent vectorized memory

Repo-scoped, local-first memory from the `backant-memory` MCP server (per-session, scoped to this repo). A background service keeps the local embedding runtime warm. Tool prefix: `mcp__backant-memory__`. Nine tools; every "action" tool takes an `action` enum.

## What happens automatically (no call needed)
- **Every prompt** is recalled against: hits arrive as `## Memory recall — <repo>` with `[tier · type · age] … (id)`. Read them; older hits may be stale.
- **Session start** injects the last session's summary ("Last session — resume here"), any handoff brief, and a digest of durable repo knowledge.
- **PreCompact / session end** writes one deterministic `session_summary` (what happened — not what you learned).

## Before deciding or building
- `memory_recall {cue, k?, tier?, types?, id?, with_edges?, edge_depth?}` — a different angle than the automatic recall, a deeper k, one entry by `id`, or relationships (`with_edges`). Returns `{hits, count, note?}`; an empty result says "no memories yet — write one".
- `procedure {action:"grounding", trigger, action_type}` — runbooks for the action: follow "follow-this", verify "draft-verify".
- `memory_maintain {action:"pattern_check", domains}` — repeated failure patterns before retrying an approach.
- `task_state {action:"read", epic_id?}` — resume a long-running epic; no epic_id lists active ones.

## After acting
- `memory_write_episode {situation, action_type, action_taken, expected, outcome, evidence}` — every meaningful attempt, especially failures and surprises. epic_id/cycle_id optional.
- `memory_write {tier:"stm"|"ltm", type, content, sources, reason?}` — `stm` for observations/hypotheses/anomalies; `ltm` ONLY for verified durable knowledge, with a reason. Do NOT write restatements of the diff, file listings, or anything greppable — write what is not derivable from the code (decisions and why, verified commands, gotchas, failure signatures, agreed conventions). Recall first so you reinforce instead of duplicating.
- `memory_reinforce {id, factor?, reason?}` — a recalled memory proved right; defaults factor 1.2, reason 'act-cite'.
- `procedure {action:"outcome", procedure_id, outcome, judge_confirmed, situation, action_type, evidence}` — whenever a runbook was applied; `{action:"propose", name, trigger, steps, depends_on_paths, sources}` after a VERIFIED success worth repeating.

## Curation (when reviewing memory, not every session)
- `memory_edit {action:"revise"|"promote"|"demote", id, new_content?, reason}`.
- `memory_graph {action:"propose"|"approve"|"reject"|"pending"|"list", ...}` — typed edges (related_to|contradicts|supports|supersedes|refines); approving a `supersedes` edge invalidates the superseded entry.
- `memory_maintain {action:"decay_sweep"}` and `procedure {action:"sweep"}` — periodic hygiene only.

## Long-running work
- `task_state {action:"write", epic_id, title, status, plan, open_threads, touched, blockers}` — rewrite the durable plan at every significant state change.

## Legacy names
Servers started with `serve --tools full` (the HTTP daemon, or `BACKANT_MEMORY_TOOLS=full`) also expose the pre-consolidation names (`memory_write_stm`, `memory_recall_with_edges`, `task_state_read`, …). They behave the same; prefer the nine above.

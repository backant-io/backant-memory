---
name: backant-memory
description: Use when starting work on any task with possible history (recall first), after completing or failing an attempt (write episode), after verifying durable knowledge (write LTM), or when a repeatable runbook emerges (propose procedure). Covers all mcp__backant-memory__* tools.
---

# backant-memory — persistent vectorized memory

Repo-scoped, local-first memory served by the always-on `backant-memory` daemon. Tool prefix: `mcp__backant-memory__`.

## Session start
1. `procedure_sweep` once per session (marks stale runbooks).
2. `task_state_read` (no args) to list active epics; with `epic_id` to resume one.

## Before deciding or building
- `memory_recall {cue, k?}` — hybrid BM25+vector+recency retrieval. ALWAYS do this before re-deriving anything that may have history.
- `memory_recall_with_edges {cue, edge_depth?}` — when consequences/relations matter.
- `memory_pattern_check {domains}` — check for repeated failure patterns before retrying an approach.
- `procedure_grounding {trigger, action_type}` — fetch runbooks for the action; follow "follow-this" results, verify "draft-verify" ones.

## After acting
- `memory_write_episode` — every meaningful attempt: situation, action, expected vs outcome, evidence.
- `memory_write_stm {type, content, sources}` — observations/hypotheses/anomalies worth keeping.
- `memory_write_ltm {type, content, sources, reason}` — ONLY verified durable knowledge.
- `procedure_outcome {procedure_id, outcome, ...}` — whenever a runbook was applied.
- `procedure_propose` — after a VERIFIED success worth repeating; list depends_on_paths honestly.

## Curation (when reviewing memory, not every session)
- `memory_reinforce` / `memory_bump_verdict_boost` — memory proved useful.
- `memory_revise_ltm` — content is outdated; state the reason.
- `memory_promote` / `memory_demote` — STM↔LTM transitions with reasons.
- `memory_edge_propose` → review → `memory_edge_approve` / `memory_edge_reject`; list open ones with `edges_pending`.
- `memory_decay_sweep` — periodic hygiene only.

## Long-running work
- `task_state_write` — rewrite the durable plan for an epic at every significant state change.

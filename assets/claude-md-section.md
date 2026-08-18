## Persistent memory (backant-memory) — ALWAYS USE

A vectorized long-term memory MCP server (`backant-memory`) is available in this session. Memory is repo-scoped: every project gets its own namespace automatically, resolved from your git origin. A background service keeps the embedding runtime warm so recall stays fast.

**Recall arrives automatically.** A `UserPromptSubmit` hook recalls against every prompt and injects the top hits as "## Memory recall — <repo>" (each line shows tier, type, age, id). Read them before acting; older entries may be stale. If a hit proves right, call `memory_reinforce(id, 1.2, "act-cite")`. For anything the automatic recall did not cover — a different angle, relationships, a concrete action — still call `memory_recall`, `memory_recall_with_edges`, or `procedure_grounding` yourself.

**Write after you learn.** After a verified outcome, decision, or surprise:
- `memory_write_stm` — observations, hypotheses, anomalies.
- `memory_write_episode` — an attempted action with expected vs actual outcome.
- `memory_write_ltm` — only for verified durable knowledge, with a reason.
- `procedure_propose` — after a verified multi-step success worth repeating.

**Maintain.** Reinforce what proved useful (`memory_reinforce`, `memory_bump_verdict_boost`); revise what changed (`memory_revise_ltm`); promote validated STM (`memory_promote`).

**Session summaries are automatic.** A `PreCompact`/`SessionEnd` hook writes one deterministic `session_summary` per session (prompts, files touched, outcome); the next session sees it as "## Last session — resume here". It records what happened, not what you learned — durable lessons still need `memory_write_ltm`.

If the `backant-memory` tools are missing from a session, run `backant-memory doctor` in a terminal.

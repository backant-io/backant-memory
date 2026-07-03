## Persistent memory (backant-memory) — ALWAYS USE

A vectorized long-term memory MCP server (`backant-memory`) is available in this session. Memory is repo-scoped: every project gets its own namespace automatically, resolved from your git origin. A background service keeps the embedding runtime warm so recall stays fast.

**Recall before you act.** Before any non-trivial decision, fix, or design on a topic that may have history, call `memory_recall` with a short cue (e.g. "auth token refresh bug"). An agent that doesn't recall is hallucinating its history. Use `memory_recall_with_edges` when relationships matter, `procedure_grounding` when starting a concrete action (fix/implement/migrate/...).

**Write after you learn.** After a verified outcome, decision, or surprise:
- `memory_write_stm` — observations, hypotheses, anomalies.
- `memory_write_episode` — an attempted action with expected vs actual outcome.
- `memory_write_ltm` — only for verified durable knowledge, with a reason.
- `procedure_propose` — after a verified multi-step success worth repeating.

**Maintain.** Reinforce what proved useful (`memory_reinforce`, `memory_bump_verdict_boost`); revise what changed (`memory_revise_ltm`); promote validated STM (`memory_promote`).

If the `backant-memory` tools are missing from a session, run `backant-memory doctor` in a terminal.

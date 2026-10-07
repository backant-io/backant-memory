# Changelog

Versions follow the git tags and GitHub Releases. 0.3.0 and 0.4.0 were tagged on GitHub and reached npm together with 0.4.1.

## 0.4.1 (2026-09-24)

- WAL journal mode, `busy_timeout` and reconnect-and-retry on `SQLITE_BUSY` for the shared namespace database (#10, fixes #8).
- launchd: boot the loaded job out before bootstrap.
- The session-summary test reads the latest summary with the same fixed clock it was written with.

## 0.4.0 (2026-08-18)

- Nine core tools as the stdio default: `memory_recall`, `memory_write`, `memory_write_episode`, `memory_reinforce`, `memory_edit`, `memory_graph`, `procedure`, `task_state`, `memory_maintain`.
- Every pre-0.4 tool name stays reachable behind `serve --tools full` (the HTTP daemon default) or `BACKANT_MEMORY_TOOLS=full`.
- `memory_recall` returns `{hits, count, note?}` and an empty result carries a note.
- ltm ids are scoped to the repo and retry on a primary-key conflict (#7).

## 0.3.0 (2026-08-18)

- `alwaysLoad: true` on the MCP entry written by `install`, so the tools are loaded in every session.
- UserPromptSubmit hook: every prompt is a cue and the top hits are injected as `## Memory recall - <repo>` with tier, type, age and id. Skips slash and trivial prompts, shows a hit once per session, 2.5 s hard deadline, warm path through the daemon's new `/recall`.
- PreCompact and SessionEnd hook: one deterministic `session_summary` row per session, shown at session start as "Last session - resume here".
- `backant-memory usage`: adoption report from Claude Code transcripts.
- Recall hits carry `created` and `last_reinforced`; the hooks honour `BACKANT_MEMORY_HOME`; `doctor` checks alwaysLoad and all hooks.

## 0.2.1 (2026-08-10)

- `postinstall` rewrites the launchd plist only when it owns it. Dependency installs and nested global installs leave an existing service untouched (#3).

## 0.2.0 (2026-08-05)

- Library export surface (`.`, `./tools`, `./docker`, `./ollama`, `./package.json`) with type declarations.
- Versioned forward-only migrations with a `schema_migrations` ledger, a `schema_version` stamp and a runtime skew guard, replacing the sha256 schema freeze.
- The session-start hook injects the handoff brief.
- The publish workflow gates on the test suite.

## 0.1.0 (2026-07-03)

- First release: the memory engine with its 24 tools as an MCP server over stdio and HTTP, repo-scoped stores, local embeddings through Ollama, a launchd service with a bearer token, the session-start recall hook, and `install`, `doctor`, `status` and `print-config`.

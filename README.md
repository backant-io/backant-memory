# backant-memory

Local-first vectorized memory for AI agents. Memories are stored in repo-scoped
namespaces derived from your git `origin` URL, so each repository gets its own
isolated memory and switching projects switches context automatically. Recall
and embeddings run **fully local** — embeddings are always computed locally via
Ollama, and no memory content ever leaves your machine.

Two surfaces share one store (`~/.claude/kairos/memory/ns-<namespace>.db`):

- **Claude Code** is registered over **stdio**. Each session spawns
  `backant-memory serve`, which resolves the repo-scoped store for that session's
  cwd — so isolation and sharing with `backant-kairos` are exact per project.
- A launchd-supervised **daemon** (label `io.backant.memory`, `127.0.0.1:41414`)
  stays always-on to keep Ollama warm, answer the authenticated SessionStart
  `/digest` warm path, and expose MCP over streamable HTTP for **other agents**.
  Note: the HTTP `/mcp` surface serves a **single global store** (repo `""`) —
  HTTP sessions carry no cwd, so it is not repo-scoped. Roots-based HTTP scoping
  is a tracked follow-up; until it lands, repo isolation is delivered on the
  stdio path (Claude Code) only.

## Requirements

- Node.js >= 20
- macOS (launchd) for the always-on background service. The stdio transport
  (`backant-memory serve --stdio`) works on any platform for other MCP clients.
- Docker (for the local Ollama embedding runtime — auto-started when needed).

## Install

```bash
npm install -g backant-memory
backant-memory install
```

`install` is idempotent — re-running it is safe and repairs drift.

## What `install` wires up

1. **Always-on service.** Generates `~/Library/LaunchAgents/io.backant.memory.plist`
   and bootstraps it via launchd (`KeepAlive` + `RunAtLoad`), plus a `0600`
   bearer-token file. The daemon survives sleep, crashes, and reboot. It keeps
   Ollama warm and serves the authenticated `/digest` + HTTP `/mcp` surfaces.
2. **MCP registration (user scope, stdio).** Registers the `backant-memory`
   server in `~/.claude.json` as a **stdio** entry
   (`command: <install>/bin/backant-memory.js`, `args: ["serve"]`). Every Claude
   Code session in every repo then sees the memory tools, each session
   repo-scoped to its own cwd. (Other MCP clients use the HTTP endpoint — see
   [Other MCP clients](#other-mcp-clients).)
3. **Global CLAUDE.md block.** Appends/updates a managed section in
   `~/.claude/CLAUDE.md` between `<!-- backant-memory:start -->` and
   `<!-- backant-memory:end -->` markers (content outside the markers is never
   touched). It nudges agents to `memory_recall` before acting on a known topic
   and `memory_write_stm` / `memory_write_episode` after a verified outcome.
4. **Skill.** Installs `~/.claude/skills/backant-memory/SKILL.md` describing when
   each tool group applies.
5. **Hooks** in `~/.claude/settings.json` (pass `--no-hook` to skip all three):
   - **SessionStart** — opens every session with a digest: the latest handoff
     brief, the latest automatic session summary ("Last session — resume here"),
     and a recall of durable repo knowledge.
   - **UserPromptSubmit** — *ambient recall*: every prompt is used as a cue and
     the top hits are injected as `## Memory recall — <repo>` with tier, type,
     age and id. Skips slash commands and trivial prompts; never repeats a hit
     within a session; hard 2.5s deadline, warm path via the daemon's `/recall`.
   - **PreCompact + SessionEnd** — writes one deterministic `session_summary`
     row per session (prompts, files touched, outcome, branch) from the
     transcript, in a detached worker so exit is never delayed. No model call.

The MCP entry is registered with `"alwaysLoad": true` so the memory tools are
never deferred behind Claude Code's tool search — a session that has to
`ToolSearch` for its memory tools mostly won't.

## Verify

```bash
backant-memory status            # launchctl state + /healthz, one line
backant-memory doctor            # every install check, pass/fail per item
backant-memory doctor --verify-restart   # SIGKILL the daemon, prove launchd relaunches it
backant-memory usage --days 30   # adoption: sessions by entrypoint, hook/digest presence, memory calls per 1k turns
```

`usage` reads the Claude Code transcripts under `~/.claude/projects` (read-only)
and is the number to watch: a store's size says nothing about whether agents
actually recall and write.

## After a reboot

There is nothing to do. Reboot, log back in, and:

```bash
backant-memory status
```

should already report `service: running; http: healthy` — launchd relaunches
the daemon at login automatically.

## Other MCP clients

`print-config` emits ready-to-paste snippets. The default (`generic`) prints
**both**: the stdio entry (recommended, per-session repo-scoped — the same shape
Claude Code is registered with) and the streamable-HTTP + `Authorization` entry
for agents that only speak HTTP (which talk to the global store).

```bash
backant-memory print-config                 # both stdio + http (generic)
backant-memory print-config --client claude # stdio only
```

## Configuration

All settings are optional and read from the environment.

| Variable | Default | Notes |
|---|---|---|
| `BACKANT_MEMORY_HOME` | `~/.claude/kairos` | Data home. Shared with `backant-kairos` on purpose. Honoured by the hooks' cold path too. |
| `BACKANT_MEMORY_PORT` | `41414` | HTTP port for the daemon. |
| `BACKANT_MEMORY_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint. Falls back to `KAIROS_OLLAMA_URL`. |
| `BACKANT_MEMORY_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Embedding model. Falls back to `KAIROS_EMBEDDING_MODEL`. |
| `BACKANT_MEMORY_DB` | *(unset)* | Read by `serve` only: pin a fixed store file, bypassing repo-scope resolution (stdio) and the global default (http). For tests and pinned single-store setups. |

Embeddings are **always** produced locally through Ollama — there are no remote
embedding APIs, ever.

## Uninstall

```bash
backant-memory uninstall
```

Reverses everything `install` did (boots out and removes the plist, and strips
only the content inside its own markers/keys). Your memories and the installed
skill directory are left in place.

## Shared database and frozen schema

The memory database lives under `BACKANT_MEMORY_HOME` and is **shared with
`backant-kairos`** (which still carries its own embedded copy of the memory
system). Because both read and write the same store, the schema is **frozen**
and checksum-pinned in both repositories until `backant-kairos` is refactored to
consume this package. See the design spec in the `backant-kairos` repo:
`docs/superpowers/specs/2026-07-03-standalone-memory-mcp-design.md`.

## License

Elastic-2.0. See [LICENSE](./LICENSE).

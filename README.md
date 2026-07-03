# backant-memory

Local-first vectorized memory for AI agents, exposed as an always-on MCP
service. Memories are stored in repo-scoped namespaces derived from your git
`origin` URL, so each repository gets its own isolated memory and switching
projects switches context automatically. Recall and embeddings run **fully
local** — a launchd-supervised daemon (label `io.backant.memory`) serves MCP
over streamable HTTP on `127.0.0.1:41414`, and embeddings are always computed
locally via Ollama. No memory content ever leaves your machine.

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
   bearer-token file. The daemon survives sleep, crashes, and reboot.
2. **MCP registration (user scope).** Registers the `backant-memory` server as
   streamable HTTP at `http://127.0.0.1:41414/mcp` with an `Authorization`
   bearer header in `~/.claude.json`. Every Claude Code session in every repo
   then sees the memory tools.
3. **Global CLAUDE.md block.** Appends/updates a managed section in
   `~/.claude/CLAUDE.md` between `<!-- backant-memory:start -->` and
   `<!-- backant-memory:end -->` markers (content outside the markers is never
   touched). It nudges agents to `memory_recall` before acting on a known topic
   and `memory_write_stm` / `memory_write_episode` after a verified outcome.
4. **Skill.** Installs `~/.claude/skills/backant-memory/SKILL.md` describing when
   each tool group applies.
5. **SessionStart recall hook.** Registers a hook in `~/.claude/settings.json`
   so every session opens with a recall digest of durable repo knowledge. Pass
   `backant-memory install --no-hook` to skip this step.

## Verify

```bash
backant-memory status            # launchctl state + /healthz, one line
backant-memory doctor            # every install check, pass/fail per item
backant-memory doctor --verify-restart   # SIGKILL the daemon, prove launchd relaunches it
```

## After a reboot

There is nothing to do. Reboot, log back in, and:

```bash
backant-memory status
```

should already report `service: running; http: healthy` — launchd relaunches
the daemon at login automatically.

## Other MCP clients

For clients other than Claude Code, emit a ready-to-paste config snippet
(streamable HTTP + `Authorization` header):

```bash
backant-memory print-config                 # generic
backant-memory print-config --client cursor
```

## Configuration

All settings are optional and read from the environment.

| Variable | Default | Notes |
|---|---|---|
| `BACKANT_MEMORY_HOME` | `~/.claude/kairos` | Data home. Shared with `backant-kairos` on purpose. |
| `BACKANT_MEMORY_PORT` | `41414` | HTTP port for the daemon. |
| `BACKANT_MEMORY_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint. Falls back to `KAIROS_OLLAMA_URL`. |
| `BACKANT_MEMORY_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Embedding model. Falls back to `KAIROS_EMBEDDING_MODEL`. |

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

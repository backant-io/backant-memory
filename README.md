# backant-memory

[![npm](https://img.shields.io/npm/v/backant-memory)](https://www.npmjs.com/package/backant-memory)
[![license](https://img.shields.io/badge/license-Elastic--2.0-blue)](./LICENSE)

Local memory for your coding agent. Every repository gets its own store, recall runs on every prompt, and everything stays on your machine.

Until now your coding agent probably started every session from zero. You explained the gotcha about the flaky integration test again, it re-derived the retry logic you had already settled last week, and the lesson from yesterday's failed migration was just gone with the context window.

You don't have to do that anymore. We have built a memory that sits next to your agent as an MCP server and a few hooks. Your agent recalls what it learned in this repo before it acts, writes down what it verified after it acts, and the next session picks up where the last one stopped. Think of it as the notes a colleague keeps about the project so they can continue on Monday where they stopped on Friday.

## Quick start

```bash
npm install -g backant-memory
backant-memory install
```

Open Claude Code in any git repository and the memory tools are there. `install` is safe to run again and running it again repairs whatever drifted.

You need Node 20 or newer and Docker. Docker is only there to run Ollama, which computes the embeddings on your machine. The always-on service uses launchd, so it is macOS for now, and the per-session server runs on any platform (see [Other agents](#other-agents)).

## What happens in a session

You open Claude Code in a repo and three things happen on their own.

**At session start** your agent gets a digest: the handoff brief if an epic is in flight, the summary of the last session under "Last session - resume here", and a recall of the durable knowledge for this repo.

**On every prompt** the prompt is used as a cue and the best hits are injected as `## Memory recall - <repo>`, each line with tier, type, age and id. Slash commands and prompts under 12 characters are skipped, a hit is shown once per session, and the hook has a hard deadline of 2.5 seconds so your prompt goes through either way.

**At compaction and at session end** one session summary is written: the prompts, the files touched, the branch and the outcome. It is built from the transcript by plain code and the next session reads it first.

Your agent also has the nine tools below, and the block `install` adds to your global `CLAUDE.md` tells it when to use them: recall before deciding, write after verifying.

## How the memory works

Everything lives in one SQLite file per GitHub owner under `~/.claude/kairos/memory/` and every row is stamped with `owner/repo` from the git origin of the working directory. Switching projects switches memory automatically and a checkout with no origin gets a local-only store.

### Two tiers

- **Short-term (stm)** is for observations, hypotheses, anomalies and episodes. It decays with every sweep (weight times 0.7) and is archived below 0.1 unless it gets reinforced.
- **Long-term (ltm)** is for verified, durable knowledge: a decision and why, a gotcha, a command that proved to work, a convention the team agreed on. Writing it requires a reason, it decays slowly (0.98) and it stays. An ltm id looks like `ltm_owner-repo_lesson_003` and every revision is kept in history.

### Episodes

An episode is an attempt at a decision point: the situation, what the agent did, what it expected and what happened, with evidence. Weight is surprise-scaled, so an outcome that matched the expectation is stored at 1.0 and a mismatch at 2.0, and similar situations recall the episode later.

### Recall

Recall is hybrid: the cue goes through BM25 full-text search and a cosine search over the embedding, and the top 50 candidates are fused with the stored weight, recency and how often the entry was cited:

```
0.4 · bm25 + 0.4 · cosine + 0.1 · weight + 0.05 · recency + 0.05 · citations
```

Recency decays over 30 days and the citation term is capped at 5. Results are cached per cue until the store changes and every recall writes a trace, so you can see later why a hit ranked where it did. Hits carry `created` and `last_reinforced` so a months-old note reads as months old.

### Reinforce and curate

When a recalled entry proved right, `memory_reinforce` raises its citation count and its ranking boost. `memory_edit` revises an ltm entry with an audit trail, promotes stm to ltm once the evidence is there, or demotes ltm back to stm when it was contradicted. `memory_maintain` runs the decay sweep and checks a domain for repeated failure patterns before you retry an approach.

### Edges

Memories relate to each other through typed edges: related_to, contradicts, supports, supersedes and refines. An edge is proposed first and approved later, and approving a supersedes edge closes the validity of the superseded entry so it stops surfacing, and `memory_recall` with `with_edges` walks them.

### Procedures and task state

A procedure is a runbook in prose that proved to work: a trigger, the steps and the files it depends on. `procedure` with `grounding` returns the matching ones when an action starts, `outcome` records whether it worked, and `sweep` marks runbooks stale whose files changed since. `task_state` keeps one durable plan per epic, rewritten at every significant step, so a long-running piece of work survives compaction and a restart.

## Tools

Nine tools, each with an `action` enum where it has more than one job.

| Tool | What it does |
|---|---|
| `memory_recall` | hybrid recall for a cue, one entry by `id`, or relationships with `with_edges` |
| `memory_write` | write a memory; `tier: stm` or `ltm`, ltm needs a `reason` |
| `memory_write_episode` | record an attempt with expected vs actual outcome and evidence |
| `memory_reinforce` | a recalled entry proved right |
| `memory_edit` | `revise`, `promote` or `demote` an entry |
| `memory_graph` | `propose`, `approve`, `reject`, `pending` or `list` edges |
| `procedure` | `grounding`, `propose`, `outcome` or `sweep` |
| `task_state` | `read` or `write` the plan for an epic |
| `memory_maintain` | `decay_sweep` or `pattern_check` |

Servers started with `serve --tools full` (the HTTP daemon does this by default) also answer to the pre-0.4 names like `memory_write_stm` and `task_state_read`. They share the handlers, so anything that still talks to the old surface keeps working.

## Shell verbs

Some agents only have a shell, so the four verbs open the same repo-scoped store the MCP server opens for that checkout, so a verb and a tool call land in one memory:

```bash
backant-memory recall --cue "auth token refresh bug" --k 5
backant-memory reinforce --id ltm_owner-repo_lesson_003
backant-memory write --tier stm --type observation \
  --content "the retry loop swallows 429s" --source src/http/retry.ts
backant-memory write --tier ltm --type lesson \
  --content "..." --source PR#41 --reason "verified by the failing test in CI"
backant-memory episode --situation "..." --action "..." \
  --expected success --outcome partial --evidence "test X still red"
```

`recall` prints one JSON object per line so it pipes into `jq` and `grep`, the other three print one JSON line with what they wrote, and a verb exits non-zero with the reason on stderr when the store or Ollama is unreachable. Run them from inside the checkout the memory belongs to.

## Commands

| Command | What it does |
|---|---|
| `backant-memory install` | wires everything up; safe to re-run, `--no-hook` skips the hooks |
| `backant-memory status` | launchd state and `/healthz` in one line |
| `backant-memory doctor` | every install check, pass or fail per item; `--verify-restart` kills the daemon and proves launchd brings it back |
| `backant-memory usage --days 30` | adoption from your Claude Code transcripts: sessions by entrypoint, hook presence, memory calls per 1k turns |
| `backant-memory print-config` | config snippets for other MCP clients |
| `backant-memory serve` | the MCP server; `--stdio` (default) or `--http` |
| `backant-memory uninstall` | reverses `install`; your memories stay |

`usage` is the number to watch, because a big store says little about whether your agents actually recall and write.

## What install wires up

1. An always-on service under launchd (`io.backant.memory` on `127.0.0.1:41414`) with a `0600` bearer token file. It keeps Ollama warm, answers the hooks on the warm path and serves MCP over HTTP for other agents. It survives sleep, crashes and reboot, and after a reboot `backant-memory status` already reports `service: running; http: healthy`.
2. The `backant-memory` MCP server in `~/.claude.json` over stdio with `alwaysLoad: true`, so every session has the tools loaded from the first turn.
3. A managed block in `~/.claude/CLAUDE.md` between `backant-memory:start` and `backant-memory:end` markers. Everything outside the markers stays yours.
4. The skill at `~/.claude/skills/backant-memory/SKILL.md`.
5. The three hooks in `~/.claude/settings.json`: SessionStart, UserPromptSubmit, and PreCompact plus SessionEnd.

## Other agents

`print-config` prints ready-to-paste snippets and the stdio entry is the one to prefer: each session spawns its own server and the store is scoped to that session's working directory. Agents that only speak HTTP use the streamable-HTTP entry with the bearer token.

```bash
backant-memory print-config                 # stdio and http
backant-memory print-config --client claude # stdio only
```

Currently the HTTP endpoint serves one global store, because an HTTP session carries no working directory to resolve a repo from. Repo scoping over HTTP through MCP roots is what we are working on next, and until it lands repo isolation is on the stdio path.

## Configuration

Everything is optional and read from the environment.

| Variable | Default | Notes |
|---|---|---|
| `BACKANT_MEMORY_HOME` | `~/.claude/kairos` | data home, shared with backant-kairos; the hooks honour it too |
| `BACKANT_MEMORY_PORT` | `41414` | daemon port |
| `BACKANT_MEMORY_OLLAMA_URL` | `http://127.0.0.1:11434` | local Ollama; falls back to `KAIROS_OLLAMA_URL` |
| `BACKANT_MEMORY_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | falls back to `KAIROS_EMBEDDING_MODEL` |
| `BACKANT_MEMORY_TOOLS` | `core` for stdio, `full` for http | tool profile |
| `BACKANT_MEMORY_DB` | unset | `serve` only: pin one store file and skip repo resolution |

A store remembers the embedding model it was built with and refuses a different one, so vector recall stays consistent across devices. Embeddings are computed on your machine through Ollama and the store is a SQLite file under your home directory.

## Uninstall

```bash
backant-memory uninstall
```

Boots the service out, removes the plist and strips only the content inside its own markers and keys, and your memories and the skill directory stay.

## Shared with kairos

The store under `BACKANT_MEMORY_HOME` is shared with backant-kairos, which carries its own copy of the memory engine for now. Both read and write it, so the schema moves forward only through the versioned migrations in `src/memory/migrations/` and a version-skew guard refuses to open a store written by a newer schema, and [CONTRIBUTING.md](./CONTRIBUTING.md) has the rules for touching it.

## Contributing

Issues and pull requests are welcome at [github.com/backant-io/backant-memory](https://github.com/backant-io/backant-memory). [CONTRIBUTING.md](./CONTRIBUTING.md) has the setup, the project layout, how the tests are organised and how a release goes out, and [CHANGELOG.md](./CHANGELOG.md) has what changed per version.

## License

Elastic-2.0. See [LICENSE](./LICENSE).

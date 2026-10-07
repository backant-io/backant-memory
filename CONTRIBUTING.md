# Contributing

Thanks for looking into this. This page has everything you need to get a change from your machine into a release.

## Before you start

A small fix with an obvious diff can go straight to a pull request. For anything bigger, open an issue first and say what you want to change and why, so we can agree on the shape before you spend the time. Issues labelled `good first issue` and `help wanted` are the ones we would like help with.

## Setup

You need Node 20 or newer. Ollama, Docker and launchctl are mocked in the test suite, so the suite runs on a clean machine on any platform.

```bash
npm ci
npm test          # builds first, then runs vitest
npm run lint      # tsc --noEmit
npm run build     # tsup, writes dist/
```

One file:

```bash
npx vitest run tests/tools/memory/recall.test.ts
```

## Layout

```
src/
  cli.ts             commander entry: serve, install, uninstall, status, doctor,
                     usage, print-config and the four shell verbs
  memory-verbs.ts    the shell verbs; each one delegates to a tool under src/tools
  server.ts          the MCP server: tool registry, core vs full profile, stdio and http
  tools/             one file per tool action; MCP and the CLI are two callers of these
  memory/            the store: libsql db, migrations, repo identity, decay,
                     recall cache and trace, procedure and episode content, types
  hooks/             the three Claude Code hooks: session-start-recall,
                     prompt-recall, session-summary
  daemon/            launchd plist, supervisor, bearer token, http routes
                     (/healthz, /digest, /recall, /mcp)
  install/           what `install` writes: mcp registration, hooks,
                     the CLAUDE.md block, the skill
  ollama/            embedding client, model install, health, tier detection
  docker/            container lifecycle for the local Ollama
  doctor.ts          the install checks
  usage.ts           the adoption report from Claude Code transcripts
  postinstall.ts     refreshes the launchd service after a global npm install
assets/              the CLAUDE.md block and the SKILL.md that install copies
tests/               mirrors src/ one to one
```

A request flows from a hook or an MCP call into `src/tools/*` and from there into `src/memory/libsql-db.ts`. The shell verbs and the MCP tools call the same functions, so a fix goes into `src/tools` and both paths get it.

## The schema

The store is shared with backant-kairos, so a schema change on one side has to keep the other side working.

- Migrations are forward-only SQL files in `src/memory/migrations/`, numbered `NNN-name.sql`. An applied migration is frozen; add a new file.
- The runner keeps a `schema_migrations` ledger and a `schema_version` stamp, and a skew guard refuses to open a store written by a newer schema, checked once before and once under the write lock.
- tsup copies the migrations directory next to every bundle that can open a store (`dist`, `dist/hooks`, `dist/tools`). If you add an entry to `tsup.config.ts` that opens a store, add its directory to that list.
- `tests/memory/migrations-*.test.ts` and `tests/memory/schema-skew.test.ts` pin the chain. Run them after any schema change.

## Tests

The suite is vitest and `tests/` mirrors `src/`. A test says why the behaviour matters, so a reader can tell what breaks when it goes red. Embeddings are stubbed with `vi.spyOn(client, "embed")`, the container lifecycle with `vi.fn()`, and `tests/dist-smoke.test.ts` runs against the built `dist/`, which is why `npm test` builds first.

## Commits and pull requests

Commit messages are `area: what changed` in plain words, for example `hooks: ambient recall on every prompt` or `store: WAL, busy_timeout and reconnect-and-retry on SQLITE_BUSY`. Areas you will see in the log: cli, hooks, tools, store, migrations, launchd, postinstall, package, publish, tests, release.

One change per pull request, with the test that fails before and passes after. The test workflow runs lint and the suite on every pull request and CodeQL runs on pushes to main.

## Trying it on your machine

```bash
npm pack
npm install -g ./backant-memory-*.tgz
backant-memory install
backant-memory doctor
```

Two things to know from doing this on a Mac that already runs the service. `postinstall` boots the loaded launchd job out before it bootstraps the new one, and the bootstrap can fail quietly; `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.backant.memory.plist` brings it back. The stdio servers of sessions that are already open keep running the old version until those sessions restart.

## Release

For maintainers.

1. Bump `version` in `package.json` and commit as `release: backant-memory X.Y.Z, <one line on what changed>`.
2. Merge to main, tag `vX.Y.Z` and push the tag.
3. Create a GitHub Release from the tag. `publish.yml` runs the suite and publishes to npm through OIDC trusted publishing, and it fails early if that version is already on npm.
4. Add the entry to `CHANGELOG.md`.

## License

Elastic-2.0. By contributing you agree that your contribution is licensed under it.

---
# dream-b7nn
title: Ingest scaffolding + local claude-sessions source end-to-end
status: completed
type: feature
priority: high
created_at: 2026-05-10T12:32:58Z
updated_at: 2026-05-10T12:57:27Z
parent: dream-xh9u
---

## What to build

The first tracer-bullet slice of the ingest phase: a working `bun run ingest` command that pulls m4x Claude Code sessions for the last 48 hours into `data/raw/m4x/claude-sessions/<encoded-cwd>/<sessionId>.jsonl` and writes a structured run log to `data/raw/_meta/YYYY-MM-DD.json`.

This slice introduces all the load-bearing scaffolding the subsequent source slices plug into: the `Source` contract, the orchestrator (parallel exec, per-source wipe-then-pull, error catching, log assembly), the run-log writer, the env-config schema, the CLI entry point, and the testing pattern (sibling tests, arrange-per-test fixtures).

Tooling is already in place in the repo (errore, zod, oxlint, oxfmt, knip, tsgo, bun test, strict tsconfig with `noUncheckedIndexedAccess`, `#src/*` import map) — this slice does not touch any of it.

See parent `dream-xh9u` for: full source contract definition, run-log schema, on-disk layout, error-handling rationale, module sketch.

## Acceptance criteria

- [x] `.env.example` content provided to user (sandbox blocks `.env*` writes); user to create the file. Vars: `DREAM_DATA_DIR` (required), `DREAM_MACHINE` (optional, defaults to `local`)
- [x] `src/config.ts` exposes a Zod-validated config object (`{dataDir, machine}`); missing/invalid env returns a `ConfigError` and `main.ts` exits 1 with a clear message. `DREAM_MACHINE` defaults to `local` so the tool runs out of the box
- [x] `src/config.test.ts` covers: valid env parses, missing required returns ConfigError, empty value returns ConfigError, machine defaults to `local`, machine read from `DREAM_MACHINE`
- [x] `src/ingest/orchestrator.ts` exports `run()` plus the `Source` and `SourceResult` types it owns; computes `outDir = {dataDir}/raw/{machine}/{source}/`, wipes + recreates before calling `pull()`, runs sources concurrently, times each call, catches throws and converts via tagged `SourceFailure` to error entries
- [x] `src/ingest/orchestrator.test.ts` uses fake sources for: wipe-before-pull, partial failure isolation, durationMs recorded both outcomes, concurrent execution under 1.8x single sleep
- [x] `src/ingest/log.ts` is a pure function from `ReadonlyArray<SourceResult>` + run window to the `_meta/YYYY-MM-DD.json` payload; output is Zod-validated; pretty-print happens at write time in `main.ts`
- [x] `src/ingest/log.test.ts` covers: all-ok, error-entry verbatim, mixed, all-error, zero sources, ISO timestamp formatting
- [x] `src/ingest/main.ts` loads config, builds sources, calls `run()`, writes the run log; exits 1 only if config invalid or `_meta/` write fails (catastrophic); otherwise 0
- [x] `ingestLocalClaudeSessions({machine, sourceDir})` factory in `src/ingest/sources/local-claude-sessions.ts` implements `Source` with the supplied machine label + `claude-sessions`; Bun glob over `<sourceDir>/**/*.jsonl` filtered by mtime > since, excludes `subagents` segment, copies preserving relative path; returns `{files_pulled, bytes}` (orchestrator adds durationMs). `main.ts` wires it with `machine: cfg.machine` (i.e. from `DREAM_MACHINE`, default `local`).
- [x] `src/ingest/sources/local-claude-sessions.test.ts` per-test tmp dir, asserts labels (incl. machine pass-through), copied set, subagent exclusion, byte count
- [x] `package.json` `scripts.ingest` runs `bun src/ingest/main.ts`
- [x] `bun run check` passes (fmt, lint, typecheck, test, knip)
- [x] Manual demo: 11 files / 4.7MB pulled, run log written with `status: ok`

## User stories addressed

From parent `dream-xh9u`: 1, 2, 3, 4, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22.

## Summary of Changes

First tracer-bullet slice of the ingest phase landed end-to-end. `bun run ingest` pulls m4x Claude Code sessions and writes a `_meta/YYYY-MM-DD.json` run log.

**Files added:** `src/config.ts`, `src/ingest/orchestrator.ts`, `src/ingest/log.ts`, `src/ingest/main.ts`, `src/ingest/sources/local-claude-sessions.ts` (+ sibling tests).

**Conventions established:**

- Zod schemas camelCase (e.g. `runLogSchema`); inferred types PascalCase (`RunLog`).
- In-memory shapes use camelCase (`durationMs`); on-disk JSON keeps snake_case (`duration_ms`). Conversion lives in `log.ts` only.
- Source files named by transport (`local-...`, `ssh-...`), not by machine. Factories named `ingest{Transport}{Source}({machine, ...})` so the same module can run on any host.
- `errore` used for `ConfigError`, `SourceFailure`, and `IngestFatal` boundary errors. Sources signal failure by throwing; orchestrator catches via `.catch` + tagged wrap.
- `Source` contract: `{machine, source, pull({outDir, since}) -> Promise<Metrics>}`. `Metrics = Record<string, number|string>` permits per-source extras.
- 17 tests across 4 files; `bun run check` passes (fmt + lint + typecheck + test + knip).

**Out-of-band fix:** the `check` script previously chained commands with `bun test && bun knip`; knip's bun plugin treats `bun test` as a substring trigger and parses chained `&&` tokens as test arg patterns, polluting entry detection. Switched to `bun run test && bun run knip` so the plugin only fires on the standalone `test` script.

**Sandbox limitation:** `.env.example` could not be written by the agent (sandbox denies `.env*`). Content was provided to the user verbatim; user must create the file.

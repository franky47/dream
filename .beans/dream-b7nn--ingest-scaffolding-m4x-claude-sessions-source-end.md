---
# dream-b7nn
title: Ingest scaffolding + m4x claude-sessions source end-to-end
status: todo
type: feature
priority: high
created_at: 2026-05-10T12:32:58Z
updated_at: 2026-05-10T12:32:58Z
parent: dream-xh9u
---

## What to build

The first tracer-bullet slice of the ingest phase: a working `bun run ingest` command that pulls m4x Claude Code sessions for the last 48 hours into `data/raw/m4x/claude-sessions/<encoded-cwd>/<sessionId>.jsonl` and writes a structured run log to `data/raw/_meta/YYYY-MM-DD.json`.

This slice introduces all the load-bearing scaffolding the subsequent source slices plug into: the `Source` contract, the orchestrator (parallel exec, per-source wipe-then-pull, error catching, log assembly), the run-log writer, the env-config schema, the CLI entry point, and the testing pattern (sibling tests, arrange-per-test fixtures).

Tooling is already in place in the repo (errore, zod, oxlint, oxfmt, knip, tsgo, bun test, strict tsconfig with `noUncheckedIndexedAccess`, `#src/*` import map) — this slice does not touch any of it.

See parent `dream-xh9u` for: full source contract definition, run-log schema, on-disk layout, error-handling rationale, module sketch.

## Acceptance criteria

- [ ] `.env.example` checked in with `DREAM_DATA_DIR` (the only env var needed at this stage); other vars added in their own slices
- [ ] `src/config.ts` exposes a Zod-validated config object; missing/invalid env throws at startup with a clear error
- [ ] `src/config.test.ts` covers: valid env parses, missing required throws, invalid value throws
- [ ] `src/ingest/orchestrator.ts` exports `run()` plus the `Source` and `SourceResult` types it owns; receives a list of sources, computes `outDir = data/raw/{machine}/{source}/` from labels, wipes + recreates each `outDir` before calling `pull()`, runs all sources concurrently via `Promise.allSettled`, times each call, catches throws from sources and converts them to error log entries (using `errore` for typed errors)
- [ ] `src/ingest/orchestrator.test.ts` uses fake sources to verify: pre-existing files in outDir are gone after run; one fake source throwing does not abort other sources; per-source `duration_ms` is recorded for both ok and error outcomes; concurrent execution (two intentionally slow fakes finish in ≈ max, not sum)
- [ ] `src/ingest/log.ts` is a pure function from `Array<SourceResult>` + run window to the `_meta/YYYY-MM-DD.json` payload; output is Zod-validated and pretty-printed
- [ ] `src/ingest/log.test.ts` covers: all-ok, mixed ok/error, all-error, zero sources, ISO timestamp formatting, schema acceptance
- [ ] `src/ingest/main.ts` is the `bun run ingest` entry point; thin wrapper that loads config, builds the source list (just `m4x-claude-sessions` at this stage), calls `orchestrator.run()`, exits 0 unless something catastrophic prevented the log from being written
- [ ] `src/ingest/sources/m4x-claude-sessions.ts` implements the `Source` contract with `machine: "m4x"`, `source: "claude-sessions"`; uses Bun glob over `~/.claude/projects/**/*.jsonl` filtered by mtime > `since`, excludes `**/subagents/**`, copies each match preserving the relative path under `outDir`; returns `{ duration_ms, files_pulled, bytes }` (orchestrator adds duration)
- [ ] `src/ingest/sources/m4x-claude-sessions.test.ts` arranges per-test: tmp source dir with handcrafted jsonl files (in-window, out-of-window, subagent-path); calls `pull()` against tmp outDir; asserts copied file set, preserved relative paths, returned metrics
- [ ] `package.json` `scripts.ingest` runs `bun src/ingest/main.ts`
- [ ] `bun run check` passes (fmt, lint, typecheck, test, knip)
- [ ] Manual demo: running `bun run ingest` against the real `~/.claude/projects/` produces a populated `data/raw/m4x/claude-sessions/` tree and a `data/raw/_meta/YYYY-MM-DD.json` with one source entry showing `status: "ok"` and a non-zero `files_pulled`

## User stories addressed

From parent `dream-xh9u`: 1, 2, 3, 4, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22.

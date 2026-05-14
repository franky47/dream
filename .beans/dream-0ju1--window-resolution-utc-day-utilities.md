---
# dream-0ju1
title: Window resolution + UTC day utilities
status: completed
type: feature
priority: normal
created_at: 2026-05-14T09:32:08Z
updated_at: 2026-05-14T12:00:00Z
parent: dream-uvok
---

## What to build

The two new pure modules that the rest of the epic builds on, with no wiring into the ingest pipeline yet. See parent PRD dream-uvok — Implementation Decisions ("Window resolution module", "UTC day helpers") and Testing Decisions.

- **Window resolution**: a single function roughly `resolveWindow(args, now) => { since, until, untilWasExplicit } | WindowError`. Owns `util.parseArgs` for `--since`/`--until`, Zod validation of ISO date-or-datetime values (bare date interpreted as `T00:00:00Z` UTC), default composition (`until ??= now`, `since ??= until − 48h`, keeping the `INGEST_WINDOW_HOURS = 48` constant), and the three error branches (`--until` without `--since`; `since >= until`; unparseable values) returned as `errore` tagged failures. No I/O.
- **UTC day helpers**: `utcDay(date) => "YYYY-MM-DD"` and `daysInRange(since, until) => string[]` enumerating UTC days from `floor(since)` through `floor(until − 1ms)` inclusive. Pure.

Verifiable on its own through its test suite — nothing else imports it yet.

## Acceptance criteria

- [x] `resolveWindow` returns the correct window for: no flags (`[now−48h, now)`), `--since` only (`[since, now)`), and both flags (`[since, until)`).
- [x] `resolveWindow` returns a tagged error for `--until` without `--since`, for `since >= until`, and for unparseable/invalid ISO values.
- [x] A bare date value is interpreted as UTC midnight; a full ISO datetime is honoured as-is.
- [x] `untilWasExplicit` is `true` iff `--until` was passed.
- [x] `utcDay` returns the correct UTC `YYYY-MM-DD` regardless of local timezone.
- [x] `daysInRange` enumerates `floor(since) … floor(until − 1ms)` inclusive: correct across month/year boundaries, returns a single day for a sub-day window, and an empty array for an empty range.
- [x] Both modules have exhaustive co-located tests; `bun check` passes.

## User stories addressed

- User story 4
- User story 5
- User story 6
- User story 7
- User story 18
- User story 19

## Summary of Changes

- `src/ingest/utc-day.ts` — `utcDay(date)` (UTC `YYYY-MM-DD` via `toISOString`) and `daysInRange(since, until)` enumerating UTC days `floor(since) … floor(until − 1ms)` inclusive by stepping fixed `DAY_MS` from `Date.UTC`-floored bounds; empty range yields `[]`.
- `src/ingest/window.ts` — `resolveWindow(argv, now)` parsing `--since`/`--until` via `node:util` `parseArgs` (`strict: true`), Zod-validating ISO date-or-datetime values (bare date → UTC midnight), composing defaults (`until ?? now`, `since ?? until − 48h`), and returning an `errore`-tagged `WindowError` for unknown flags, `--until` without `--since`, unparseable values, and `since >= until`.
- Co-located exhaustive test suites for both modules.
- `.prettierignore` adds `.beans/` — oxfmt (via `bun check`) was reformatting tool-managed beans markdown; excluding them keeps `bun check` green without fighting the beans CLI.

`strict: true` was chosen for `parseArgs` over `strict: false` because the loose mode widens `values.since` to `string | boolean`, defeating type narrowing; strict mode rejects unknown flags through the same `WindowError` path. The pipeline-wiring task can revisit if it needs to pass through other flags.

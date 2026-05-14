---
# dream-7ear
title: 'OpenCode: strict until SQL bound + per-day splitter routing'
status: completed
type: feature
priority: normal
created_at: 2026-05-14T09:32:15Z
updated_at: 2026-05-14T12:00:00Z
parent: dream-uvok
blocked_by:
    - dream-vlrz
---

## What to build

Refine the OpenCode sources beyond the mechanical contract migration done in dream-vlrz: push the upper bound into SQL and route session files per-day from the splitter. See parent PRD dream-uvok — Implementation Decisions ("OpenCode pull library changes", "Per-source day routing").

- `buildProjectionSql` gains a strict `time_updated < until` bound (alongside the existing `> since`), so the projection query itself honours the half-open window instead of relying on a TypeScript post-query filter.
- The projected session JSON object includes `time_updated`.
- `splitJsonlToSessionFiles` reads `time_updated` off the first (session) row of each session and routes that session's `.jsonl` file into `data/<day>/<machine>/opencode/…` keyed by its UTC day.
- Both local-opencode and ssh-opencode benefit (shared `pull` lib); ssh-opencode passes `until` into the remote SQL.

## Acceptance criteria

- [x] `buildProjectionSql` filters `time_updated` to the half-open `[since, until)` window; sessions updated at or after `until` are excluded by the query.
- [x] The projected session row carries `time_updated`.
- [x] `splitJsonlToSessionFiles` routes each session file to the UTC day of its `session.time_updated`.
- [x] local-opencode and ssh-opencode both produce correctly day-bucketed output for a backfill window.
- [x] `projection.test.ts` and `splitter.test.ts` are extended for the `< until` bound and per-day routing; `bun check` passes.

## User stories addressed

- User story 12 (opencode specifics)

## Summary of Changes

- **`projection.ts`** — `buildProjectionSql` and `projectRows` gain an `untilMs` param (validated as a non-negative integer like `sinceMs`). The SQL now filters `time_updated > since AND time_updated < until` at all three filter sites (session WHERE + the two `IN (...)` subqueries), so the half-open `[since, until)` window is enforced by the query itself. The projected session JSON object now carries `time_updated`.
- **`splitter.ts`** — `splitJsonlToSessionFiles` signature changed from `{ lines, outDir }` to `{ lines, dataDir, machine }`. It reads `time_updated` off each session's header row (the first row of each session, guaranteed by the projection's `ORDER BY ... type_rank`) and routes that session's `.jsonl` into `data/<utcDay(time_updated)>/<machine>/opencode/`, creating the day dir per session.
- **`local-opencode.ts` / `ssh-opencode.ts`** — wired to the new signatures; `buildRemoteCmd` (ssh) threads `untilMs` into the remote SQL; `runSshOpencodePipeline` takes `dataDir` instead of a pre-computed `outDir`. The interim single-bucket routing from dream-vlrz is removed — both sources now route per-session.
- **Layering fix** — `utc-day.ts` moved from `src/ingest/` to `src/lib/` (imported as `#lib/utc-day`). dream-vlrz had `src/lib/opencode/pull/splitter.ts` needing it; a `lib → ingest` import is an inverted dependency. `utcDay`/`daysInRange` are pure helpers that belong in `lib/`. All five import sites updated.

A bad session header (missing `time_updated`, or a non-session row arriving first) surfaces as a `ZodError` — left as an unguarded invariant check, matching the existing `unreachable: handle is null` guard, because the projection's `ORDER BY` + the schema's `NOT NULL time_updated` make it unreachable.

---
# dream-7ear
title: 'OpenCode: strict until SQL bound + per-day splitter routing'
status: todo
type: feature
priority: normal
created_at: 2026-05-14T09:32:15Z
updated_at: 2026-05-14T09:32:15Z
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

- [ ] `buildProjectionSql` filters `time_updated` to the half-open `[since, until)` window; sessions updated at or after `until` are excluded by the query.
- [ ] The projected session row carries `time_updated`.
- [ ] `splitJsonlToSessionFiles` routes each session file to the UTC day of its `session.time_updated`.
- [ ] local-opencode and ssh-opencode both produce correctly day-bucketed output for a backfill window.
- [ ] `projection.test.ts` and `splitter.test.ts` are extended for the `< until` bound and per-day routing; `bun check` passes.

## User stories addressed

- User story 12 (opencode specifics)

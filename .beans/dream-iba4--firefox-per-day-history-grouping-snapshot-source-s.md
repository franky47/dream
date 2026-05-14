---
# dream-iba4
title: 'Firefox: per-day history grouping + snapshot-source skip on backfill'
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

Refine the Firefox source beyond the mechanical contract migration done in dream-vlrz: route history rows per-day from SQL and skip the snapshot-shaped sub-sources on backfill runs. See parent PRD dream-uvok — Implementation Decisions ("Per-source day routing"), Out of Scope, and Further Notes.

- The history query (`QUERY_PLACES`) gains a strict `last_visit_date < until` bound and exposes a UTC routing day; it keeps `GROUP BY url`. Each row routes to the UTC day of its `last_visit_date`. No `moz_historyvisits` join — a URL appears only in its most-recent-visit day-bucket.
- The `ingestLocalFirefox` factory gains an `includeSnapshots` option; `main.ts` passes `includeSnapshots: !untilWasExplicit`. The flag is bound at construction time and is NOT part of the `Source.pull` contract.
- When `includeSnapshots` is false (a backfill run, `--until` explicitly passed), the open-tabs and synced-tabs snapshot sub-sources are skipped entirely; only history is produced. When true (window ends at now), they are captured as today.

## Acceptance criteria

- [ ] Firefox history query honours the half-open `[since, until)` window and routes each URL row to the UTC day of its `last_visit_date`.
- [ ] History output for a backfill window is split across the correct `data/<day>/<machine>/firefox/…` buckets.
- [ ] With `includeSnapshots: false`, no open-tabs or synced-tabs files are written.
- [ ] With `includeSnapshots: true`, open-tabs and synced-tabs are written under today's bucket as before.
- [ ] `main.ts` passes `!untilWasExplicit` so a no-flag or `--since`-only run still captures snapshots, and an explicit `--until` run skips them.
- [ ] `local-firefox.test.ts` is extended for per-day history grouping and both `includeSnapshots` modes; `bun check` passes.

## User stories addressed

- User story 13
- User story 14
- User story 15

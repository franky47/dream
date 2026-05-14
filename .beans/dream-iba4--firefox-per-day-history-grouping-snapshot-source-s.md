---
# dream-iba4
title: 'Firefox: per-day history grouping + snapshot-source skip on backfill'
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

Refine the Firefox source beyond the mechanical contract migration done in dream-vlrz: route history rows per-day from SQL and skip the snapshot-shaped sub-sources on backfill runs. See parent PRD dream-uvok — Implementation Decisions ("Per-source day routing"), Out of Scope, and Further Notes.

- The history query (`QUERY_PLACES`) gains a strict `last_visit_date < until` bound and exposes a UTC routing day; it keeps `GROUP BY url`. Each row routes to the UTC day of its `last_visit_date`. No `moz_historyvisits` join — a URL appears only in its most-recent-visit day-bucket.
- The `ingestLocalFirefox` factory gains an `includeSnapshots` option; `main.ts` passes `includeSnapshots: !untilWasExplicit`. The flag is bound at construction time and is NOT part of the `Source.pull` contract.
- When `includeSnapshots` is false (a backfill run, `--until` explicitly passed), the open-tabs and synced-tabs snapshot sub-sources are skipped entirely; only history is produced. When true (window ends at now), they are captured as today.

## Acceptance criteria

- [x] Firefox history query honours the half-open `[since, until)` window and routes each URL row to the UTC day of its `last_visit_date`.
- [x] History output for a backfill window is split across the correct `data/<day>/<machine>/firefox/…` buckets.
- [x] With `includeSnapshots: false`, no open-tabs or synced-tabs files are written.
- [x] With `includeSnapshots: true`, open-tabs and synced-tabs are written under today's bucket as before.
- [x] `main.ts` passes `!untilWasExplicit` so a no-flag or `--since`-only run still captures snapshots, and an explicit `--until` run skips them.
- [x] `local-firefox.test.ts` is extended for per-day history grouping and both `includeSnapshots` modes; `bun check` passes.

## User stories addressed

- User story 13
- User story 14
- User story 15

## Summary of Changes

- **`local-firefox.ts`** — `QUERY_PLACES` gains `AND last_visit_date < $untilMicros` (half-open `[since, until)` window) and a `routing_day` column (`strftime('%Y-%m-%d', MAX(last_visit_date)/1000000, 'unixepoch')` — UTC, matching `utcDay()`). `placeRowSchema` gains `routing_day`. `pull` groups history rows by `routing_day` and writes one `history.csv` per `data/<day>/<machine>/firefox/` bucket. The `<stamp>.` filename prefix is dropped (`history.csv`/`bookmarks.csv`/`open-tabs.csv`) since the day is now in the path. `localDateStamp` removed.
- **`includeSnapshots` flag** — the factory gains `includeSnapshots?: boolean` (default `true`), bound at construction. When `false` (backfill run), the snapshot-shaped sub-sources — bookmarks, open-tabs *and* synced-tabs — are skipped entirely; only the time-windowed history is written. When `true`, they're written under the snapshot-day bucket (`utcDay(until − 1ms)` ≈ today).
- **`main.ts`** — passes `includeSnapshots: !untilWasExplicit`.

### Decisions

- **Bookmarks counts as a snapshot.** The bean/user-story 14 name only open-tabs and synced-tabs explicitly, but the bean's "only history is produced" on backfill and "a backfill run only ever writes past day-buckets" are decisive: bookmarks is a current-state dump with no time window, so it's skipped on backfill alongside open-tabs/synced-tabs.
- **Snapshot day is seeded into the per-day map** (`rowsByDay.set(snapshotDay, [])`) when `includeSnapshots` is true, so the snapshot bucket always gets a (possibly header-only) `history.csv` next to its bookmarks/open-tabs — a complete firefox dataset per day. Real rows routing to that day append to the seeded array.
- The `since` bound stays exclusive (`> $sinceMicros`, pre-existing) for cross-source consistency with `find -newermt`; `visited` stays localtime (display-only) while `routing_day` is UTC (bucket key).

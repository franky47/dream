---
# dream-uvok
title: Backfill window for ingestion (--since/--until, date-bucketed data dir)
status: todo
type: epic
priority: normal
created_at: 2026-05-14T08:47:07Z
updated_at: 2026-05-14T08:47:07Z
---

## Problem Statement

The ingestion process has only ever been run ad hoc, never on a regular schedule. It hardcodes a fixed 48-hour lookback window ending at "now", so there is no way to ingest data from further back in time. As downstream pipeline stages come online, the user wants to process several months of historical data in one pass — but the tool cannot reach back past the last two days, and re-running it would destroy the freshly-ingested data because each run wipes and rewrites the per-source output directory.

## Solution

Add an explicit, optional time window to the ingestion command via two CLI flags, `--since <iso>` and `--until <iso>`. With no flags, behaviour is unchanged (the last 48 hours up to now). With flags, the user can ingest an arbitrary past window — e.g. a few months — in a single invocation.

To make repeated and overlapping runs safe, the `data/` directory is re-organised to be indexed by UTC day first: `data/<YYYY-MM-DD>/<machine>/<source>/…`. Each run clears only the day-buckets its window spans and refills them, so backfilling the past never clobbers other days, and adjacent or overlapping windows reconcile cleanly at day granularity. This day-first layout is also the natural input shape for the downstream daily-digest pipeline.

## User Stories

1. As a user catching up on months of un-ingested history, I want to pass `--since <date>` so that a single run ingests everything from that date up to now.
2. As a user, I want `--since` and `--until` together to define a bounded historical window, so that I can backfill a specific past range.
3. As a user running the tool normally, I want the no-flag invocation to behave exactly as before (last 48h up to now), so that existing habits and any scheduled runs are unaffected.
4. As a user, I want `--until` alone (without `--since`) to be rejected with a clear error, so that I do not accidentally run an unbounded or surprising window.
5. As a user, I want a window where `since >= until` to be rejected with a clear error, so that nonsensical windows fail fast instead of silently doing nothing.
6. As a user, I want unparseable or non-ISO date values to be rejected with a clear error and a non-zero exit code, so that typos do not silently produce an empty or wrong ingest.
7. As a user, I want to pass either a bare date (`2026-01-15`) or a full datetime (`2026-01-15T12:00:00Z`), so that I can choose the precision I need; a bare date is interpreted as UTC midnight.
8. As a user backfilling a past window, I want each ingested item filed under the UTC day it belongs to, so that the resulting data is organised chronologically rather than by run.
9. As a user re-running an overlapping window, I want the run to clear and refill only the day-buckets it covers, so that re-running is idempotent and does not duplicate or strand data.
10. As a user backfilling the past, I want a run to never touch day-buckets outside its window, so that previously-ingested days (including today's data) are preserved.
11. As a user, I want the downstream daily-digest pipeline to be able to read one day's complete cross-source, cross-machine dataset from a single directory, so that consuming a day requires no globbing across the tree.
12. As a user backfilling history, I want Claude and OpenCode session files routed to the UTC day of their last activity, so that each session lands in exactly one chronological bucket.
13. As a user backfilling history, I want Firefox history rows routed to the UTC day of the URL's most recent visit, so that history is filed chronologically.
14. As a user backfilling a past window, I want snapshot-shaped sources (Firefox open-tabs and synced-tabs) to be skipped, so that a backfill run only ever writes past day-buckets and never mutates today's data with a "now" snapshot.
15. As a user running the tool normally (window ending at now), I want open-tabs and synced-tabs snapshots to still be captured, so that current tab state continues to be ingested.
16. As a user, I want each run's log file named by its run-start timestamp, so that multiple backfill runs on the same day do not overwrite each other's logs.
17. As a user reviewing a past run, I want the run log to record the `since`/`until` window it covered, so that I can tell exactly what each backfill run ingested.
18. As a user, I want the half-open interval semantics `[since, until)` to be consistent across every source, so that adjacent windows tile perfectly with no double-counting.
19. As a developer, I want window resolution (arg parsing, defaults, validation) extracted as a pure, isolated module, so that all the branching and error logic is testable without I/O.
20. As a developer, I want a run that fails to clear its target day-buckets to abort fatally with a non-zero exit code, so that ingestion never proceeds against a directory in an unknown state.

## Implementation Decisions

**CLI surface (`main.ts`)**
- Two new optional flags `--since <iso>` and `--until <iso>`, parsed with Bun's built-in `util.parseArgs` (no new dependency).
- Values validated with Zod as ISO date-or-datetime. A bare date is interpreted as `T00:00:00Z` (UTC).
- Default composition: `until` defaults to `now` (invocation time); `since` defaults to `until − 48h`. The existing `INGEST_WINDOW_HOURS = 48` constant remains the named default-window size.
- Error cases, surfaced as `errore` tagged failures with a non-zero exit code: `--until` provided without `--since`; `since >= until`; unparseable/invalid values.
- Internal variable names: `since` / `until`.

**Window resolution module (new, deep, pure)**
- A new module exposes a single function roughly `resolveWindow(args, now) => { since, until, untilWasExplicit } | WindowError`.
- Owns `util.parseArgs`, Zod validation, default composition, and all error branches. No I/O.

**UTC day helpers (new leaf util)**
- `utcDay(date) => "YYYY-MM-DD"`.
- `daysInRange(since, until) => string[]` — enumerates UTC days from `floor(since)` through `floor(until − 1ms)` inclusive; the set of day-buckets a run clears.
- Pure; shared by the orchestrator and every source's routing logic.

**Interval semantics**
- Half-open `[since, until)`. Every source filters items strictly `since <= ts < until`.
- ssh-claude cannot express a strict upper bound through `find -newermt`, so it post-filters extracted files by mtime in TypeScript (it already `stat`s every extracted file). This guarantees no item routes to a day outside the cleared range.

**Data directory layout**
- Changes from `data/<machine>/<source>/…` to `data/<YYYY-MM-DD>/<machine>/<source>/…` (UTC days).
- `data/_meta/` stays top-level (the `_` prefix sorts it away from date dirs); one backfill run spans many day-buckets but produces a single run log.
- Empty days never get a directory: the clear pre-pass only removes, and sources lazily `mkdir` as they write.

**Orchestrator changes**
- `Source.pull` contract changes from `pull({ outDir, since })` to `pull({ dataDir, since, until })`. Each source builds `dataDir/<day>/<machine>/<source>/…` itself, since only the source knows an item's day key.
- The destructive clear moves out of `runOne` and becomes a pre-pass in `run()`: compute `daysInRange(since, until)`, `rm -rf data/<day>` for each (in parallel), then launch all sources concurrently. Sources write to disjoint subpaths so concurrent writes remain safe.
- A failure during the clear pre-pass is run-fatal (`IngestFatal`, non-zero exit), not a per-source error.

**Per-source day routing**
- claude local/ssh: the whole session/memory file is routed by its file mtime's UTC day.
- opencode local/ssh: the whole session file is routed by `session.time_updated`'s UTC day.
- firefox history: query keeps `GROUP BY url`; each row routes to the UTC day of its `last_visit_date`. No `moz_historyvisits` join — a URL appears only in its most-recent-visit day, which is acceptable. Query gains a strict `< until` bound and exposes a UTC routing day.
- firefox open-tabs / synced-tabs: snapshot sources, skipped on backfill runs. `main.ts` passes `includeSnapshots: !untilWasExplicit` to the `ingestLocalFirefox` factory; the flag is bound at construction time and is deliberately NOT part of the `Source.pull` contract.

**OpenCode pull library changes**
- `buildProjectionSql` gains a strict `time_updated < until` bound and includes `time_updated` in the projected session JSON object.
- `splitJsonlToSessionFiles` reads the session timestamp off the first (session) row of each session to choose that session's per-day output directory.

**Run log changes**
- Run log files are named by run-start timestamp (ISO, e.g. `data/_meta/<timestamp>.json`) instead of run-start date, so same-day runs never clobber.
- `buildRunLog` payload gains `since` and `until` fields.

## Testing Decisions

Good tests here exercise external behaviour, not implementation details: given inputs (argv, a fixed `now`, fixture files/DBs) they assert on outputs (the resolved window, the error, the on-disk day-bucket layout, the run-log payload) — never on internal call sequences.

- **Window resolution module** — new dedicated test file, exhaustive: every default-composition branch (neither flag, `--since` only, both), every error branch (`--until` alone, `since >= until`, unparseable values), bare-date-as-UTC-midnight, and the `untilWasExplicit` flag. Pure function, fixed `now` injected — no I/O.
- **UTC day helpers** — new dedicated test file covering edge cases: month/year boundaries, the `floor(until − 1ms)` exclusive-upper behaviour, empty ranges, single-day ranges, and that `daysInRange` output aligns with the half-open interval.
- **Per-source day routing** — extend the existing co-located source test files (`local-claude.test.ts`, `ssh-claude.test.ts`, `local-opencode.test.ts`, `ssh-opencode.test.ts`, `local-firefox.test.ts`) with windowed cases asserting items land in the correct `data/<day>/…` bucket and that out-of-window items are excluded. Prior art: these files already use injected fixture directories/DBs at the smallest seam.
- **Orchestrator clear pre-pass** — extend `orchestrator.test.ts` to assert only the in-range day-buckets are cleared, out-of-range buckets are preserved, and a clear failure aborts the run fatally. Prior art: existing orchestrator tests already drive `run()` with fake `Source` objects.
- **OpenCode projection + splitter** — extend the existing `projection.test.ts` and `splitter.test.ts` for the `< until` bound and per-day output routing.
- **Firefox snapshot skip** — assert that with `includeSnapshots: false` no open-tabs/synced-tabs files are written, and with `true` they are.

## Out of Scope

- Relative date expressions (`--since 2.days`, `--since yesterday`). Only absolute ISO values are supported.
- Backfilling open-tabs / synced-tabs history. These are pure "now" snapshots; there is no historical data to recover, and backfill runs skip them by design.
- A `moz_historyvisits` join for true per-visit-day Firefox history accuracy. A URL appears only in its most-recent-visit day-bucket.
- Migration of any existing `data/` directory from the old `data/<machine>/<source>/…` layout to the new date-first layout. The next run repopulates; stale data can be cleared manually.
- A dry-run / preview mode for inspecting which day-buckets a window would clear.
- Scheduling or automating regular ingestion runs.
- Reconciling partial-source failures across a backfill: if a source fails mid-run, its subpaths for the cleared days are simply missing until the next run re-clears and retries — same failure model as today.

## Further Notes

- The half-open `[since, until)` convention extends the existing exclusive-lower filter (`mtime > since`) to the upper bound. Practical consequence: `--since 2026-02-01 --until 2026-03-01` ingests all of February and nothing from March 1; to include March 1, pass `--until 2026-03-02`.
- Per the project's "simplest per-case impl" preference, day-routing is implemented independently in each source rather than behind a shared routing abstraction; only the pure `utcDay` / `daysInRange` leaf utils are shared.
- The `untilWasExplicit` boolean (used only to decide the Firefox snapshot skip) is intentionally kept out of the shared `Source.pull` contract — it is bound at `ingestLocalFirefox` construction time so the orchestrator never needs to know snapshot sources exist.

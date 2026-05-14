---
# dream-vlrz
title: Date-bucketed layout, CLI window flags, Source.pull contract change
status: todo
type: feature
priority: normal
created_at: 2026-05-14T09:32:12Z
updated_at: 2026-05-14T09:32:12Z
parent: dream-uvok
blocked_by:
    - dream-0ju1
---

## What to build

The tracer spine: the atomic `Source.pull` contract change plus everything needed to make `bun ingest --since <date>` produce a date-bucketed `data/` directory end-to-end. See parent PRD dream-uvok — Implementation Decisions ("Data directory layout", "Orchestrator changes", "Run log changes") and Interval semantics.

- `Source.pull` contract changes from `{ outDir, since }` to `{ dataDir, since, until }`. **All five sources** are migrated to the new signature in this slice (TypeScript will not compile otherwise).
- The destructive clear moves out of `runOne` into a pre-pass in `run()`: `daysInRange(since, until)` → `rm -rf data/<day>` for each in parallel, then sources launch concurrently. A clear-pre-pass failure is run-fatal (`IngestFatal`, non-zero exit).
- New layout `data/<YYYY-MM-DD>/<machine>/<source>/…`; `data/_meta/` stays top-level; empty days never get a directory.
- `main.ts` wires `--since`/`--until` through `resolveWindow` (dream-0ju1), surfacing errors with a non-zero exit code; no-flag behaviour is unchanged.
- Run log files are named by run-start timestamp; `buildRunLog` payload gains `since`/`until`.
- **claude local/ssh**: full day-routing by file mtime's UTC day, strict half-open `[since, until)` filter. ssh-claude extracts to a temp dir then post-filters by mtime in TypeScript before routing.
- **opencode + firefox**: migrated to the new signature and routed correctly via `utcDay`, filtering by `until` in TypeScript post-query (correct, but the SQL-level upper bound, opencode splitter routing, firefox per-day grouping and snapshot skip are deferred to dream-7ear / dream-iba4).

## Acceptance criteria

- [ ] `bun ingest` with no flags behaves exactly as before (last 48h up to now), but writes to `data/<day>/<machine>/<source>/…`.
- [ ] `bun ingest --since <date>` and `--since <date> --until <date>` ingest the correct window; invalid flag combinations exit non-zero with a clear message.
- [ ] A run clears and refills only the day-buckets within `[since, until)`; day-buckets outside the window are untouched.
- [ ] All five sources compile and run against the new `{ dataDir, since, until }` contract; no source writes outside the cleared day range.
- [ ] claude local/ssh route each session/memory file to its mtime's UTC day; out-of-window files are excluded.
- [ ] A failure in the clear pre-pass aborts the whole run with a non-zero exit code.
- [ ] Run log is named by run-start timestamp and its payload records `since`/`until`.
- [ ] Existing orchestrator and claude source tests are extended with windowed cases; `bun check` passes.

## User stories addressed

- User story 1
- User story 2
- User story 3
- User story 8
- User story 9
- User story 10
- User story 11
- User story 12 (claude)
- User story 16
- User story 17
- User story 20

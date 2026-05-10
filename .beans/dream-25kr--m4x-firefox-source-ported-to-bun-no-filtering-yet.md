---
# dream-25kr
title: Local Firefox source ported to Bun (no filtering yet)
status: todo
type: feature
priority: normal
created_at: 2026-05-10T12:33:04Z
updated_at: 2026-05-10T12:33:04Z
parent: dream-xh9u
blocked_by:
  - dream-b7nn
---

## What to build

Port the prototype shell exporter (`~/dev/playground/firefox-history-exporter/firefox-history-exporter.sh`) into a typed Bun module that lives inside the dream repo as the third source. Output is a per-run csv at `data/raw/m4x/firefox/YYYY-MM-DD.csv`. **No filtering in this slice** — the csv contains every URL visited in the window. Domain blocklist filtering is a separate slice (`dream-bytd`) so we can inspect the unfiltered output and tune the blocklist against real data.

This slice lifts the core mechanics that the shell script established: lock-safe sqlite snapshot to a tmp dir, query with a `since` cutoff, `GROUP BY url`, strip query strings and fragments. Reimplemented in Bun via `bun:sqlite` and `Bun.file` so the source is testable, env-driven (no hardcoded profile path), and uniform with the other source modules.

See parent `dream-xh9u` for the source contract, the run-log schema, and the rationale for keeping smart privacy filtering in the enrichment phase.

## Acceptance criteria

- [ ] `src/config.ts` (and `.env.example`) extended with `FIREFOX_PROFILE` (Zod-validated path to the Firefox profile directory containing `places.sqlite`)
- [ ] `src/ingest/sources/local-firefox.ts` exports `ingestLocalFirefox({machine, profileDir})`, implementing the `Source` contract with the supplied machine label + `source: "firefox"` (wired in `main.ts` with `machine: "m4x"`)
- [ ] On `pull()`: copy `${FIREFOX_PROFILE}/places.sqlite` and `places.sqlite-wal` to a tmp dir before opening (lock-safe; works while Firefox is running)
- [ ] Query against the tmp copy via `bun:sqlite`: `last_visit_date > strftime('%s', $since) * 1000000`, `GROUP BY url`, strip query string (everything from `?` onward) and fragment (everything from `#` onward) before grouping
- [ ] Output csv with columns `visited`, `url`, `title`; one file per run named `YYYY-MM-DD.csv` (run-date in local time)
- [ ] Returns `{ files_pulled: 1, bytes, rows }` (orchestrator adds `duration_ms`)
- [ ] Source is added to the source list in `src/ingest/main.ts`
- [ ] `src/ingest/sources/local-firefox.test.ts` arranges per-test: each test creates a fresh tmp `places.sqlite` via `bun:sqlite` with only the rows that case needs (matching the Firefox `moz_places` schema columns the source actually reads), then calls `pull()` against tmp `outDir` and asserts on the produced csv
- [ ] Test cases: in-window vs out-of-window cutoff; duplicate URLs collapse to a single row with the most recent `visited`; URLs with query strings and fragments are normalised; lock-safe behaviour exercised by leaving the test's sqlite handle open during `pull()` (verifies the snapshot mechanism works without the test having to close the connection first)
- [ ] `bun run check` passes
- [ ] Manual demo: `bun run ingest` produces a populated `data/raw/m4x/firefox/YYYY-MM-DD.csv` with real browsing data and a corresponding entry in the run log

## User stories addressed

From parent `dream-xh9u`: 7, 9, 14, 15.

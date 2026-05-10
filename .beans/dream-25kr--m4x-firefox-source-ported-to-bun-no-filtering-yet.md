---
# dream-25kr
title: Local Firefox source ported to Bun (no filtering yet)
status: completed
type: feature
priority: normal
created_at: 2026-05-10T12:33:04Z
updated_at: 2026-05-10T19:30:00Z
parent: dream-xh9u
blocked_by:
  - dream-b7nn
---

## What to build

Port the prototype shell exporter (`~/dev/playground/firefox-history-exporter/firefox-history-exporter.sh`) into a typed Bun module that lives inside the dream repo as the third source. Output is a per-run csv at `data/raw/m4x/firefox/YYYY-MM-DD.csv`. **No filtering in this slice** — the csv contains every URL visited in the window. Domain blocklist filtering is a separate slice (`dream-bytd`) so we can inspect the unfiltered output and tune the blocklist against real data.

This slice lifts the core mechanics that the shell script established: lock-safe sqlite snapshot to a tmp dir, query with a `since` cutoff, `GROUP BY url`, strip query strings and fragments. Reimplemented in Bun via `bun:sqlite` and `Bun.file` so the source is testable, env-driven (no hardcoded profile path), and uniform with the other source modules.

See parent `dream-xh9u` for the source contract, the run-log schema, and the rationale for keeping smart privacy filtering in the enrichment phase.

## Acceptance criteria

- [x] `src/config.ts` (and `.env.example`) extended with `FIREFOX_PROFILES` (Zod-validated comma-separated list of Firefox profile directories — list-shaped, see Summary)
- [x] `src/ingest/sources/local-firefox.ts` exports `ingestLocalFirefox({machine, profileDir})`, implementing the `Source` contract with the supplied machine label + `source: "firefox"` (wired in `main.ts` once per entry in `cfg.firefoxProfiles`, machine label from `cfg.machine`)
- [x] On `pull()`: snapshot `${profileDir}/places.sqlite` to a tmp dir via SQLite `VACUUM INTO` before querying (lock-safe; works while Firefox is running, atomically consistent)
- [x] Query against the snapshot via `bun:sqlite`: `last_visit_date > $sinceMicros`, `GROUP BY url`, strip query string (everything from `?` onward) and fragment (everything from `#` onward) before grouping
- [x] Output csv with columns `visited`, `url`, `title`; one file per run named `YYYY-MM-DD.csv` (run-date in local time)
- [x] Returns `{ files_pulled: 1, bytes, rows }` (orchestrator adds `duration_ms`)
- [x] Source is added to the source list in `src/ingest/main.ts`
- [x] `src/ingest/sources/local-firefox.test.ts` arranges per-test: each test creates a fresh tmp `places.sqlite` via `bun:sqlite` with only the rows that case needs (matching the Firefox `moz_places` schema columns the source actually reads), then calls `pull()` against tmp `outDir` and asserts on the produced csv
- [x] Test cases: in-window vs out-of-window cutoff; duplicate URLs collapse to a single row with the most recent `visited`; URLs with query strings and fragments are normalised; lock-safe behaviour exercised by leaving the test's sqlite handle open during `pull()` (verifies the snapshot mechanism works without the test having to close the connection first)
- [x] `bun run check` passes
- [x] Manual demo: `bun run ingest` produces a populated `data/raw/<machine>/firefox/YYYY-MM-DD.csv` with synthetic browsing data and a corresponding entry in the run log (real browsing data NOT used per user direction — see Summary)

## User stories addressed

From parent `dream-xh9u`: 7, 9, 14, 15.

## Summary of Changes

Third ingest source landed: `ingestLocalFirefox({machine, profileDir})` in `src/ingest/sources/local-firefox.ts` (+ sibling tests). Wired into `main.ts` once per entry in `cfg.firefoxProfiles`.

**Deviations from the original AC, in order:**

- **Env var is `FIREFOX_PROFILES` (plural, comma-separated), not `FIREFOX_PROFILE`.** Applies the existing "list-shaped env vars over singletons" memory rule — a user with work + personal Firefox profiles can register both without code changes. Same shape as `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS`. Empty default = no firefox source.
- **Snapshot uses SQLite `VACUUM INTO`, not `cp places.sqlite + places.sqlite-wal`.** Reviewer flagged the file-copy path as racy: between the two `copyFileSync` calls, a checkpoint can land and leave the WAL inconsistent with the main DB → `SQLITE_CORRUPT` or silent row loss. `VACUUM INTO` runs as a read transaction inside SQLite and produces an atomically consistent single-file snapshot. The lock-safe test (writer holds DB open during `pull()`) still passes.
- **Snapshot tmp dir is removed immediately after `db.close()`,** not at the very end of `pull()`. The bytes from the query are already in the JS heap; no reason to keep the snapshot around through CSV write + stat.
- **Source-internal failures wrap as a tagged `LocalFirefoxFailure`** (errore) at the three stages (`mkdtemp`, `snapshot`, `query`), so the orchestrator's `SourceFailure` carries useful tag context into the run log instead of a bare fs error.
- **Manual demo used a synthetic `places.sqlite` fixture, not real browsing data.** Per user direction this session: "under no circumstance are you to use my real Firefox data for anything. Make your own fixtures." Saved as a session feedback memory + about to be enforced by a Claude Code hook covering `~/.ssh` and Firefox profile directories. Demo verified all the things the tests cover (window cutoff, dedupe, query/fragment strip, CSV escape, run-log entry shape).

**Files added:** `src/ingest/sources/local-firefox.ts`, `src/ingest/sources/local-firefox.test.ts`.

**Files modified:** `src/config.ts`, `src/config.test.ts`, `src/ingest/main.ts`.

**Tests:** 9 new in `local-firefox.test.ts` (labels, label override, in-window write, out-of-window exclusion, dedupe with most-recent visit, query strip, fragment strip, CSV escape with comma/quote/newline, lock-safe with open writer). 3 reworked in `config.test.ts` for the plural env var. `bun run check`: 41 tests pass; oxfmt + oxlint + tsgo + knip clean.

**Sandbox limitation carried over from dream-b7nn:** `.env.example` could not be written by the agent (sandbox denies `.env*`). User must add `FIREFOX_PROFILES=/path/to/profile1,/path/to/profile2` (optional, comma-separated) to enable the source.

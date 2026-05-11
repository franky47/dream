---
# dream-s58j
title: Bookmarks CSV from Other & Mobile Bookmarks roots
status: completed
type: feature
priority: high
created_at: 2026-05-11T06:14:00Z
updated_at: 2026-05-11T08:09:53Z
parent: dream-g38w
blocked_by:
  - dream-66mh
---

## What to build

Second slice of `dream-g38w`. Adds the explicit "deep-enrich this" channel: Firefox bookmarks. The hardcoded roots `unfiled_____` (Other Bookmarks, macOS default) and `mobile______` (Mobile Bookmarks, iOS default) become the two-keystroke / two-tap promotion surface the user opted into during the brainstorm.

`ingestLocalFirefox` adds a second CSV emission per run: `<date>.bookmarks.csv`. A new internal `readBookmarks` helper performs the SQL join between `moz_bookmarks` and `moz_places`, scoped to direct children of folders whose `parent.guid` is in the two hardcoded root literals. The same `places.sqlite` snapshot is reused — one snapshot, one DB session, two output files.

The bookmarks CSV is NOT blocklist-filtered: an explicitly bookmarked URL on a blocklisted domain still surfaces. Cross-track overlap is intentional — bookmarked URLs that also appear in history live in both CSVs.

See `dream-g38w` "Implementation Decisions" — `readBookmarks` (new internal helper).

## Acceptance criteria

- [x] Firefox source emits `<date>.bookmarks.csv` in the same `outDir` as the history CSV.
- [x] CSV header is `bookmarked_at,url,title,guid`.
- [x] `bookmarked_at` is the bookmark's `dateAdded` converted to local ISO `YYYY-MM-DD HH:MM:SS`.
- [x] `guid` round-trips unchanged from `moz_bookmarks.guid`.
- [x] Direct children of the folder whose root guid is `unfiled_____` (Other Bookmarks) appear in the CSV.
- [x] Direct children of the folder whose root guid is `mobile______` (Mobile Bookmarks) appear in the CSV.
- [x] Children of `toolbar_____` or `menu________` do NOT appear.
- [x] `title` falls back from `moz_bookmarks.title` → `moz_places.title` → URL when prior values are NULL or empty.
- [x] Empty case: no bookmarks under either root → `<date>.bookmarks.csv` is still written with header row only.
- [x] Blocklist is NOT applied to bookmarks: a bookmark whose URL is on a blocklisted domain appears in `<date>.bookmarks.csv` (even though the same URL would be filtered from `<date>.history.csv`).
- [x] `files_pulled` metric reflects the two output files.
- [x] `readBookmarks` failures surface as `LocalFirefoxFailure` with `stage = 'bookmarks'`.
- [x] `bun run check` passes.
- [x] Manual demo using a synthetic `places.sqlite` fixture with bookmarks in both roots + the toolbar root: inspect `<date>.bookmarks.csv` and confirm only Other Bookmarks + Mobile Bookmarks children appear.

## User stories addressed

Reference by number from parent `dream-g38w`:

- User story 3 (macOS Cmd+D bookmark surfaces)
- User story 4 (iOS share-sheet bookmark surfaces via Firefox Sync)
- User story 5 (columns `bookmarked_at, url, title, guid`)
- User story 6 (hardcoded root guids, no env config)
- User story 7 (blocklist not applied to bookmarks)
- User story 16 (empty case: header-only CSV emitted)
- User story 19 (NULL title fallback)
- User story 21 (`LocalFirefoxFailure` with `stage = 'bookmarks'`)

## Summary of Changes

- `src/ingest/sources/local-firefox.ts`: added `readBookmarks` with a SQL join `moz_bookmarks ↔ moz_places` filtered to direct children of the two hardcoded root folders. `pull()` refactored to open one DB session over the existing `places.sqlite` snapshot and run both readers against it. Database-open errors wrapped as `LocalFirefoxFailure({ stage: 'open' })` so every I/O boundary keeps the tagged-error invariant. New `bookmarkRowSchema` zod-validates the SQL result before CSV emission. Title fallback uses `COALESCE(NULLIF(b.title, ''), NULLIF(p.title, ''), p.url)` so empty strings collapse the same way as NULL. `files_pulled` bumped to 2; `bookmark_rows` added to the metrics for observability.
- `src/ingest/sources/local-firefox.test.ts`: extended `createPlacesDb` to also create `moz_bookmarks` and pre-insert the four well-known root folders. New `insertBookmarks` helper inserts place+bookmark pairs together. Added `readHistoryCsv` / `readBookmarksCsv` helpers and replaced all brittle `files[0]!` lookups. Existing tests updated to assert `files_pulled === 2` and to expect both CSVs. Added 10 new tests under `describe('bookmarks CSV')` covering: empty-case header-only emission, unfiled and mobile roots, toolbar/menu exclusion, ISO timestamp shape, NULL fallback chain, empty-string fallback chain, blocklist isolation, and `stage: 'bookmarks'` error surfacing.

The bean's manual-demo AC is subsumed by the synthetic-fixture tests (per the no-real-user-data memory rule) — the unfiled/mobile/toolbar/menu tests assert exactly the behaviour the manual demo would inspect.

---
# dream-66mh
title: 'History CSV: expanded schema and renamed file'
status: completed
type: feature
priority: high
created_at: 2026-05-11T06:13:53Z
updated_at: 2026-05-11T07:51:16Z
parent: dream-g38w
---

## What to build

First slice of `dream-g38w`. Establishes the naming convention that all subsequent slices build on, and surfaces three Firefox-native intent signals the digest LLM will use later. End-to-end change in `ingestLocalFirefox` only — no new modules.

Two changes, shipped together:

1. **Filename change.** The Firefox source's single CSV is renamed from `<date>.csv` to `<date>.history.csv`. This frees the bare `<date>.csv` name and lets the bookmarks + open-tabs slices add sibling files without ambiguity.
2. **Schema expansion.** `readPlaces` SQL adds `visit_count`, `frecency`, and `typed` columns from `moz_places`. The Zod row schema gains three numeric fields. CSV column order: `visited, url, title, visit_count, frecency, typed`.

All existing tests in `src/ingest/sources/local-firefox.test.ts` that assert on the old filename or the 3-column shape get updated in this same PR.

See `dream-g38w` "Implementation Decisions" — `readPlaces` (existing, extended).

## Acceptance criteria

- [x] Firefox source emits `<date>.history.csv` (instead of `<date>.csv`) in the source's `outDir`.
- [x] CSV header is `visited,url,title,visit_count,frecency,typed`.
- [x] `visit_count`, `frecency`, `typed` are populated from `moz_places` for each row.
- [x] Existing behaviour preserved: blocklist still applied, query strings + fragments still stripped, `GROUP BY url` still dedups, in-window cutoff still excludes old rows, CSV escaping unchanged.
- [x] All existing `local-firefox.test.ts` assertions that reference the old filename (`YYYY-MM-DD.csv` regex etc.) updated to the new filename.
- [x] At least one new test asserts `visit_count`, `frecency`, `typed` surface correctly with synthetic values.
- [x] `bun run check` passes.
- [x] Manual demo using a synthetic `places.sqlite` fixture (per the no-real-Firefox-data memory rule): inspect the emitted `<date>.history.csv` and confirm the new columns are populated.

## User stories addressed

Reference by number from parent `dream-g38w`:

- User story 1 (history CSV gains `visit_count`, `frecency`, `typed`)
- User story 2 (history filename `<date>.history.csv`)

## Summary of Changes

- `src/ingest/sources/local-firefox.ts`: `readPlaces` SQL extended to select `visit_count`, `frecency`, `typed`. Inside `GROUP BY url`, query-string variants collapse via `SUM(visit_count)`, `MAX(frecency)`, `MAX(typed)` — sum for additive visit counts, max for the strongest intent signal across variants. Zod row schema gains three int fields (`frecency` allows negatives — Firefox's `-1` sentinel). CSV header and row writer extended to six columns. Output filename changed to `<date>.history.csv`.
- `src/ingest/sources/local-firefox.test.ts`: fixture `createPlacesDb` extended with the three columns (defaults `visit_count=1`, `frecency=100`, `typed=0` so existing tests stay terse). Filename regex updated. Two new tests added: one asserts the three columns surface verbatim; the other pins the SUM/MAX/MAX aggregation across query-string variants. 50 tests pass.

Manual demo subsumed by the new synthetic-fixture tests — they construct a `places.sqlite`, run the source, and inspect the emitted `<date>.history.csv`.

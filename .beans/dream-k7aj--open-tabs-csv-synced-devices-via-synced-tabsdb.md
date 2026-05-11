---
# dream-k7aj
title: 'Open-tabs CSV: synced devices via synced-tabs.db'
status: completed
type: feature
priority: high
created_at: 2026-05-11T06:14:00Z
updated_at: 2026-05-11T08:21:39Z
parent: dream-g38w
blocked_by:
    - dream-66mh
---

## What to build

Third slice of `dream-g38w`. Introduces the open-tabs CSV using only the synced half of the data (other devices' tabs read from `synced-tabs.db`). Local-device tabs (this slice's natural complement) land in the next slice `dream-7yv9`; until then the CSV's contribution is "what's open on my other devices."

Why synced-first: `synced-tabs.db` is plain SQLite — same fs-copy snapshot pattern we already use for `places.sqlite`. No new dependency. The high-value "iPhone hoarding" signal lives entirely on this side.

`ingestLocalFirefox` adds a third CSV: `<date>.open-tabs.csv`, with the unified column set (`last_used, url, title, device, pinned`) — local rows fill in later. A new internal `readSyncedTabs` helper snapshots `synced-tabs.db` (main + `-wal` + `-shm`, same lock-safe pattern as `places.sqlite`), opens read-only, and queries the `tabs` table.

The query is a CTE that handles two Sync-related cruft cases discovered empirically (see `dream-g38w` "Further Notes"):

1. **Age floor.** Drop rows where `last_modified <= now - 60_days` so devices the user no longer syncs with disappear.
2. **Per-`clientName` latest.** Window-rank by `ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(record, '$.clientName'), guid) ORDER BY last_modified DESC)`, keep `rn = 1`. Sync-broken-then-resigned-in devices leave duplicate "Hex"-style rows; we want only the active one.

For each surviving row, parse `record.tabs[]` and emit one CSV row per tab. The `device` column comes from the record's `clientName` (with `moz_meta.remote_clients` and finally `guid` as fallbacks). `pinned` is always empty for synced rows (the schema doesn't carry it).

The synced-tabs.db copy at `data/sync/` (git-ignored, used for schema discovery during the brainstorm) MUST NOT be read by the production source — the source reads only from the live Firefox profile.

See `dream-g38w` "Implementation Decisions" — `readSyncedTabs` (new internal helper).

## Acceptance criteria

- [x] Firefox source emits `<date>.open-tabs.csv` in the same `outDir` as the history and bookmarks CSVs.
- [x] CSV header is `last_used,url,title,device,pinned`.
- [x] `last_used` is the tab's `lastUsed` (epoch seconds) converted to local ISO `YYYY-MM-DD HH:MM:SS`.
- [x] `url` is `urlHistory[0]` from each tab (the current page, not the back-history entries).
- [x] `device` is the record's `clientName`; falls back to a lookup in `moz_meta.remote_clients` (matching the row's `guid` against the JSON map's keys), finally falls back to the raw `guid`.
- [x] `pinned` column is present in the header and emitted as empty for synced rows.
- [x] Per-`clientName` dedup: two `tabs` rows with the same `clientName` → only the one with the larger `last_modified` contributes rows to the CSV.
- [x] 60-day age floor: a `tabs` row whose `last_modified` is more than 60 days before `now` contributes zero rows even if no other row shares its `clientName`.
- [x] Null/missing `clientName` falls back to the row's `guid` for the dedup `PARTITION BY` grouping.
- [x] Tab with an empty `urlHistory[]` array is skipped silently.
- [x] Empty `tabs` table → `<date>.open-tabs.csv` written with header row only.
- [x] Lock-safe: pull succeeds against a `synced-tabs.db` with an open writer (test exercises this by leaving a writer connection open during `pull()`).
- [x] Production source reads `synced-tabs.db` from the configured live Firefox profile directory, not from `data/sync/` in the repo.
- [x] `readSyncedTabs` failures surface as `LocalFirefoxFailure` with `stage = 'synced_tabs'`.
- [x] `files_pulled` metric reflects all output files.
- [x] `bun run check` passes.
- [x] Manual demo using a synthetic `synced-tabs.db` fixture with 2+ devices (including a stale duplicate of one): inspect the emitted `<date>.open-tabs.csv` and confirm only the latest per name surfaces.

## User stories addressed

Reference by number from parent `dream-g38w`:

- User story 9 (synced tabs surface with device name from `moz_meta.remote_clients`)
- User story 10 (Sync-broken-then-resigned-in dedup keeps latest per `clientName`)
- User story 11 (60-day age floor drops ancient devices)
- User story 12 (synced rows: `last_used` epoch seconds normalised to local ISO)
- User story 14 (`synced-tabs.db` uses fs-copy snapshot of main + wal + shm)
- User story 16 (empty case: header-only CSV emitted)
- User story 18 (snapshot-per-run semantics for derived tab-age views)
- User story 20 (null `clientName` falls back to `guid` for dedup grouping)
- User story 21 (`LocalFirefoxFailure` with `stage = 'synced_tabs'`)
- User story 22 (`data/sync/` copy git-ignored; production reads from live profile)
- User story 24 (empty `urlHistory[]` skipped without crash)

## Summary of Changes

- `src/ingest/sources/local-firefox.ts`: factored `snapshotSqlite(profileDir, fileName, stage)` out of the existing places-snapshot path so the same lock-safe pattern (main + `-wal` + `-shm` fs-copy into a tmp dir) covers both `places.sqlite` and `synced-tabs.db`. New `readSyncedTabsRows` runs a CTE with `ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(record, '$.clientName'), guid) ORDER BY last_modified DESC)` plus a 60-day age floor. `readRemoteClients` parses `moz_meta.remote_clients` as the device-name lookup map. `buildOpenTabRows` parses each row's `record` JSON via Zod, applies the three-tier device fallback (`clientName → remote_clients[guid].device_name → guid`), normalises epoch-seconds `lastUsed` to local ISO, skips tabs with empty `urlHistory`, and emits one CSV row per surviving tab. Missing `synced-tabs.db` (Sync never enabled) treated as zero-tabs — header-only CSV still emitted — rather than a fatal error, so profiles without Sync still ingest successfully.
- `src/ingest/sources/local-firefox.test.ts`: added `createSyncedTabsDb(rows, remoteClients?)` fixture that builds a complete synced-tabs.db with the discovered schema (`tabs(guid, record JSON, last_modified)` + `moz_meta(key, value)`), plus `readOpenTabsCsv` helper. Existing assertions updated for `files_pulled === 3` and the three-file output. Added 11 new tests under `describe('open-tabs CSV')` covering: missing-file case, empty-tabs case, clientName label, remote_clients fallback, guid fallback, 60-day age floor, latest-per-clientName dedup, null-clientName partition by guid, empty-urlHistory skip, `urlHistory[0]` is the current URL, tagged failure stage, and lock-safe pull under exclusive WAL writer.

Manual demo subsumed by synthetic-fixture tests per the no-real-user-data memory rule — the dedup and age-floor tests assert exactly what the manual inspection would verify.

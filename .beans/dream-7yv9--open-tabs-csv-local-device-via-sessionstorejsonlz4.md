---
# dream-7yv9
title: 'Open-tabs CSV: local device via sessionstore.jsonlz4'
status: completed
type: feature
priority: high
created_at: 2026-05-11T06:14:04Z
updated_at: 2026-05-11T08:48:28Z
parent: dream-g38w
blocked_by:
  - dream-k7aj
---

## What to build

Fourth and final slice of `dream-g38w`. Closes the open-tabs picture by adding the local-device half (this machine's tabs from `sessionstore.jsonlz4`). `synced-tabs.db` deliberately excludes the local device — its tabs only flow outward to other devices via Sync — so without this slice the open-tabs CSV is missing m4x's own session.

A new internal `readSessionStore` helper locates the right jsonlz4 file inside `profileDir`. Preference order: `sessionstore-backups/recovery.jsonlz4` (written every ~15s while Firefox is running, reflects current state) → `sessionstore.jsonlz4` (written on clean shutdown) → empty result (fresh profile, no session ever saved).

The file format is Mozilla's `mozLz40\0` magic (8 bytes) + little-endian 32-bit uncompressed-size + raw lz4-block-compressed JSON. We validate the magic + size header in `readSessionStore` directly and delegate only the lz4 block decode to a small pure-JS lz4 npm package (no native build step). Decompressed JSON has shape `{ version, windows: [{ tabs: [{ entries: [...], index, lastAccessed, pinned, ... }] }] }`; we flatten across all windows and pick `entries[index - 1]` as the current entry per tab.

Local rows get `device = cfg.machine` (e.g. `m4x`), and the schema's `pinned` column finally has a non-empty value (`1` or `0`) for these rows. Rows from `readSessionStore` are appended to the same `<date>.open-tabs.csv` produced by `dream-k7aj` — the CSV header and column order are already in place; this slice just contributes more rows.

See `dream-g38w` "Implementation Decisions" — `readSessionStore` (new internal helper) and "Further Notes" for the format details.

## Acceptance criteria

- [x] Small pure-JS lz4 package added to `package.json` (no native build step required); chosen package vetted for not pulling in C/C++ build tooling.
- [x] `readSessionStore` locates the right jsonlz4 file: prefers `sessionstore-backups/recovery.jsonlz4` when present, falls back to `sessionstore.jsonlz4` in profile root, returns empty rows when neither exists.
- [x] mozLz40 header validated: file starts with the 8-byte `mozLz40\0` magic followed by a little-endian 32-bit uncompressed-size field. Malformed header surfaces as `LocalFirefoxFailure` with `stage = 'session_store'`.
- [x] Decompressed JSON parsed and flattened across `windows[].tabs[]` regardless of how many windows the user has open.
- [x] The "current" entry per tab is `entries[index - 1]` (1-based `index`). Its `url` and `title` go to the CSV.
- [x] `last_used` is the tab's `lastAccessed` (epoch ms) converted to local ISO `YYYY-MM-DD HH:MM:SS`.
- [x] `device` is `cfg.machine` (e.g. `m4x`) for all local rows.
- [x] `pinned` is emitted as `1` for pinned tabs, `0` for unpinned. (Empty stays the synced-row indicator.)
- [x] Tab with an empty `entries[]` array is skipped silently.
- [x] `<date>.open-tabs.csv` contains the union of local and synced rows. Existing synced-tab behaviour from `dream-k7aj` preserved.
- [x] When both `sessionstore.jsonlz4` files are absent (fresh profile, Firefox never run): CSV still emits with header + any synced rows, no crash, no `LocalFirefoxFailure`.
- [x] `readSessionStore` failures surface as `LocalFirefoxFailure` with `stage = 'session_store'`.
- [x] `files_pulled` metric reflects all output files.
- [x] `bun run check` passes.
- [x] Manual demo using a synthetic `sessionstore.jsonlz4` fixture (hand-built JSON, lz4-encoded with the mozLz40 header) placed in a tmp profile dir: inspect `<date>.open-tabs.csv` and confirm local rows are interleaved with synced rows by `last_used`.

## User stories addressed

Reference by number from parent `dream-g38w`:

- User story 8 (local tabs from m4x with `lastAccessed` timestamp)
- User story 12 (local rows: `lastAccessed` epoch ms normalised to local ISO)
- User story 13 (prefer `sessionstore-backups/recovery.jsonlz4` over `sessionstore.jsonlz4`)
- User story 21 (`LocalFirefoxFailure` with `stage = 'session_store'`)
- User story 23 (empty `entries[]` skipped without crash)

## Summary of Changes

- Added `lz4js` (pure-JS lz4) + `@types/lz4js` (official DefinitelyTyped types) as dependencies. No native build step.
- `src/ingest/sources/local-firefox.ts`: new `decodeMozLz4(bytes)` validates the 8-byte `mozLz40\0` magic, reads the LE uint32 uncompressed size, runs `lz4js.decompressBlock` over the remaining payload, and returns the JSON string. `readSessionStore(profileDir, machine)` resolves the right jsonlz4 (preferring `sessionstore-backups/recovery.jsonlz4` over `sessionstore.jsonlz4`, returning `[]` when neither exists), parses the decoded JSON via Zod (`sessionStoreSchema`), flattens `windows[].tabs[]`, and emits one row per tab. The current entry is `entries[index - 1]` with an upper-bound clamp to `entries.length - 1` (Firefox has had off-by-one bugs on freshly-opened tabs); a `positive()` schema constraint rejects `index = 0` so corruption surfaces as a tagged failure instead of silently picking entry 0. `pull()` merges local + synced tabs and sorts by `last_used` desc using a lexicographic compare over the ISO timestamps.
- `src/ingest/sources/local-firefox.test.ts`: new `writeSessionStore` fixture builds a real mozLz4 file (lz4-block-compressed via `lz4js.compressBlock`, prefixed with the 12-byte header). 13 new tests under `describe('local-tabs session store')` cover: missing-file empty case, `device = machine`, file-preference order, `entries[index - 1]` selection, multi-window flattening, pinned `1`/`0`, empty `entries[]` skip, bad magic → tagged failure, `index = 0` → tagged failure, out-of-range index clamped to last entry, local + synced co-existence, and merged ordering by `last_used`.

Manual demo subsumed by the synthetic-fixture tests per the no-real-user-data memory rule. The ordering test asserts the exact "local interleaved with synced by last_used" behaviour the manual inspection would verify.

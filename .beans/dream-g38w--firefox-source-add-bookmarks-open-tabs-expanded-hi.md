---
# dream-g38w
title: 'Firefox source: add bookmarks, open tabs, expanded history schema'
status: completed
type: epic
priority: high
created_at: 2026-05-11T05:52:49Z
updated_at: 2026-05-11T08:50:33Z
---

## Summary of Changes

All four child slices shipped:

- `dream-66mh` (history CSV expanded): renamed output to `<date>.history.csv`; SQL now selects `visit_count`, `frecency`, `typed` with SUM/MAX/MAX aggregation across query-string variants under one cleaned URL.
- `dream-s58j` (bookmarks CSV): new `readBookmarks` SQL join over `moz_bookmarks ↔ moz_places` filtered to direct children of the `unfiled_____` and `mobile______` root folders; one DB session shared with `readPlaces`. Title falls back via `COALESCE(NULLIF(b.title, ''), NULLIF(p.title, ''), p.url)`. Blocklist deliberately not applied — explicit bookmarks survive even when their domain is filtered from history.
- `dream-k7aj` (synced open-tabs): `readSyncedTabsRows` does per-`clientName` window-rank dedup + 60-day age floor on the snapshotted `synced-tabs.db`. Device label falls back through `clientName → moz_meta.remote_clients[guid].device_name → guid`. Snapshot path factored to `snapshotSqlite(profileDir, fileName, stage)` so places and synced-tabs share the lock-safe main+wal+shm fs-copy.
- `dream-7yv9` (local open-tabs): new `decodeMozLz4` + `readSessionStore` parse Mozilla's `mozLz40\0` + LE uint32 + raw lz4-block container, flatten `windows[].tabs[]`, pick `entries[index - 1]` with upper-bound clamp, emit local rows tagged with `device = cfg.machine`. Merged local + synced rows are sorted by `last_used` desc. Added `lz4js` + official `@types/lz4js`.

Cross-cutting decisions:

- Missing optional input files (`synced-tabs.db`, `sessionstore.jsonlz4`, `recovery.jsonlz4`) treated as zero-rows / header-only CSV rather than fatal — Firefox doesn't create these until the relevant feature is enabled, and the source must still ingest for users without Sync or with fresh profiles.
- Every reader wraps its own failures as `LocalFirefoxFailure` with a stage discriminator: `query | bookmarks | open | synced_tabs | session_store | snapshot | mkdtemp | blocklist`.
- Schemas tightened where corruption would otherwise hide (e.g. `sessionstore.tabs[].index` is `positive()`; bad records surface as tagged failures instead of silently picking entry 0).

Test count: 30 → 85 (Firefox source); `bun check` green.

## Problem Statement

The current Firefox source emits a single CSV of browsing history per run with thin signal (`visited, url, title`). Two consequences flow from this:

- **No "I deliberately promoted this" signal.** Every URL competes on equal terms in the digest, drowning the URLs I genuinely cared about under casual browsing.
- **No "tab I left open and never read" signal.** My read-later hoarding pattern is invisible to dream, so the system can't help me clear that mental backlog.

The history CSV also discards columns Firefox already computes for free (`visit_count`, `frecency`, `typed`), so even where Firefox has the intent signal, downstream analysis has nothing to work with.

## Solution

Extend the Firefox source to produce three CSV files per run instead of one:

- **`<date>.history.csv`** — daily browsing history. Existing shape, extended with `visit_count`, `frecency`, `typed`.
- **`<date>.bookmarks.csv`** — current contents of Firefox's `Other Bookmarks` (`unfiled_____`) and `Mobile Bookmarks` (`mobile______`) roots. Bookmarking on either macOS Firefox (`Cmd+D` + Enter) or iOS Firefox (share-sheet → Bookmarks) becomes my explicit "deep-enrich this" signal — two keystrokes / two taps, no folder picking. A downstream Track A consumer (separate future bean) reads this CSV, dedups against a JSONL state file, and enqueues new bookmarks for full enrichment.
- **`<date>.open-tabs.csv`** — current open tabs across all my devices: local tabs from `sessionstore.jsonlz4`, remote tabs from `synced-tabs.db`. Each row tagged with `device` so a downstream digest can surface "this tab has been open on iPhone for 14 days now."

The existing domain blocklist continues to apply to history only — bookmarks and open tabs are explicit signals, not noise to be filtered.

## User Stories

1. As a dream user, I want my Firefox browsing history CSV to include `visit_count`, `frecency`, and `typed` columns, so that downstream digesters can distinguish "URL I typed deliberately into the address bar" from "URL I clicked through once."
2. As a dream user, I want the history CSV's filename to reflect its content (`<date>.history.csv`), so that future sibling outputs can coexist in the same directory without ambiguity.
3. As a dream user, I want any URL I bookmark on macOS Firefox (`Cmd+D` + Enter, default location `Other Bookmarks`) to appear in `<date>.bookmarks.csv`, so I can promote URLs to deep enrichment with the lowest-friction keystroke.
4. As a dream user, I want any URL I bookmark on iOS Firefox (share-sheet → Bookmarks, default location `Mobile Bookmarks`) to appear in `<date>.bookmarks.csv` after Firefox Sync propagates it to m4x, so I can promote URLs from my phone with the same friction profile.
5. As a dream user, I want the bookmarks CSV to carry `bookmarked_at, url, title, guid`, so the downstream Track A consumer can dedup against a state file keyed by the stable Firefox bookmark guid.
6. As a dream user, I want bookmark extraction limited to the well-known root folder guids `unfiled_____` and `mobile______`, so I don't have to maintain a `dream` folder or any env configuration — the platform defaults are the contract.
7. As a dream user, I want the blocklist applied only to the history CSV and not to bookmarks or open tabs, so that a URL I explicitly bookmarked from a blocklisted domain still reaches enrichment.
8. As a dream user, I want my open tabs on m4x to appear in `<date>.open-tabs.csv` with their `lastAccessed` timestamp, so I can see how long each tab has been languishing.
9. As a dream user, I want my open tabs on remote devices (Firefox on iPhone, other macOS Firefox profiles) to appear in the same CSV with `device` set to the device name from `moz_meta.remote_clients`, so the digest can show "still open on iPhone."
10. As a dream user, I want Sync-broken-then-resigned-in devices deduped to the latest entry per device name, so a stale "Hex" entry from three months ago doesn't pollute the open-tabs view with tabs I closed long ago.
11. As a dream user, I want device entries whose `last_modified` is older than 60 days dropped entirely from the open-tabs CSV, so ancient cruft from devices I no longer use disappears.
12. As a dream user, I want the open-tabs CSV columns `last_used, url, title, device, pinned` to be uniformly typed across local and synced sources — sessionstore's epoch-ms `lastAccessed` and synced-tabs' epoch-seconds `lastUsed` both normalized to local ISO — so downstream consumers don't need to know which side a row came from.
13. As a dream user, I want the local-tabs reader to prefer `sessionstore-backups/recovery.jsonlz4` over `sessionstore.jsonlz4`, so the captured tab state reflects what's actually open even while Firefox is running.
14. As a dream user, I want the source to use the same fs-copy snapshot approach for `synced-tabs.db` as for `places.sqlite` (copy `.db` + `-wal` + `-shm` into a tmp dir before reading), so concurrent Firefox writes don't corrupt my read.
15. As a dream user, I want `files_pulled` in the run log to reflect the three CSVs the source writes per run, so the metrics tell me each sub-source contributed.
16. As a dream user, I want each CSV to emit at least its header row even when the underlying source has zero matching rows (no bookmarks in the configured roots, no tabs in any session file), so downstream consumers can rely on file existence and CSV shape regardless of state.
17. As a dream user, I want the bookmarks CSV to NOT strip URLs that also appear in the history CSV, so the digest LLM sees both signals (URL was visited at 14:32 AND deliberately bookmarked).
18. As a dream user, I want the open-tabs CSV to be a current-state snapshot per run (not an event stream), so that by diffing N consecutive daily snapshots a downstream view can derive "tab has been open for N days."
19. As a dream user, I want bookmarks with a `NULL` or empty title to fall back to the place's title or its URL, so the CSV always has a non-empty title column.
20. As a dream user, I want synced-tab records whose `clientName` is missing or null to fall back to the row's `guid` for dedup grouping, so a malformed sync record doesn't accidentally merge with a different physical device.
21. As a dream user, I want sub-source failures (places query failed, sessionstore unreadable, synced-tabs locked) to surface as tagged `LocalFirefoxFailure` errors with a `stage` discriminator (`places`, `bookmarks`, `synced_tabs`, `session_store`), so the run log tells me which sub-source broke without me having to dig.
22. As a dream user, I want my repo copy of `synced-tabs.db` (used for schema discovery, lives at `data/sync/`) to remain git-ignored, and the production source to read only from the live Firefox profile, so personal browsing data is never accidentally vendored into the repo.
23. As a dream user, I want a tab whose `entries[]` array is empty (corrupt or freshly-opened tab) to be skipped silently rather than crashing the run, so a single bad tab doesn't kill ingest.
24. As a dream user, I want a tab whose `urlHistory[]` array is empty in a synced record to be skipped silently for the same reason.

## Implementation Decisions

- **`ingestLocalFirefox`** (existing) extended to emit three CSVs in the same `outDir`. Public interface unchanged; internal `pull()` orchestrates four readers in sequence under one snapshot context.
- **`readPlaces`** (existing, extended) — SELECT extended with `visit_count`, `frecency`, `typed`. Zod row schema gains three numeric fields. All other behaviour preserved (blocklist applied, query strings and fragments stripped, `GROUP BY url`, in-window cutoff).
- **`readBookmarks`** (new internal helper) — joins `moz_bookmarks` ↔ `moz_places` for direct children (`type = 1`) of folders whose `parent.guid` is in `('unfiled_____', 'mobile______')`. Returns `{bookmarked_at, url, title, guid}` rows. Zod-validated row schema. `title` falls back from `moz_bookmarks.title` to `moz_places.title` to the URL if both are NULL.
- **`readSyncedTabs`** (new internal helper) — fs-copy snapshots `synced-tabs.db` + its `-wal` + `-shm` into a tmp dir (same lock-safe pattern as `snapshotPlaces`). Queries `tabs` with a CTE that:
  1. Filters `last_modified > (current epoch ms) - (60 * 86_400_000)` to drop ancient cruft.
  2. Window-ranks rows by `ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(record, '$.clientName'), guid) ORDER BY last_modified DESC)`.
  3. Keeps `rn = 1` per group.
     Parses each surviving `record.tabs[]` JSON; emits one row per tab with `device` set to `clientName` (falling back to the `moz_meta.remote_clients` lookup, then to the `guid`).
- **`readSessionStore`** (new internal helper) — locates the jsonlz4 file inside `profileDir` (prefer `sessionstore-backups/recovery.jsonlz4`, fall back to `sessionstore.jsonlz4`, return empty if neither exists). Validates the `mozLz40\0` 8-byte magic plus little-endian 32-bit uncompressed-size header. lz4-decompresses the remainder, parses JSON, flattens `windows[].tabs[]`, picks `entries[index - 1]` per tab as the current entry. Tags rows with `device = cfg.machine` for downstream uniformity.
- **lz4 dependency** — one small pure-JS lz4 package added to `package.json` (no native build step). Header parsing (`mozLz40\0` + uncompressed-size) is implemented directly in `readSessionStore`; only the lz4 block decode is delegated. Malformed header surfaces as a tagged `LocalFirefoxFailure`.
- **Timestamp normalization** — all three CSVs emit local ISO strings (`YYYY-MM-DD HH:MM:SS`). sessionstore's `lastAccessed` is epoch ms; synced-tabs' `lastUsed` is epoch seconds. Conversion happens inside the row mappers; consumers see uniform format.
- **Blocklist scope** — existing domain blocklist (`config/firefox-blocklist.txt`) continues to apply to `<date>.history.csv` only. Bookmarks and open-tabs CSVs are unfiltered.
- **Source failure modes** — each of the four readers (`readPlaces`, `readBookmarks`, `readSyncedTabs`, `readSessionStore`) wraps its own errors as tagged `LocalFirefoxFailure` with a `stage` discriminator. Sub-source failures do not abort the run; each is emitted as a partial-failure run-log entry per existing source-error semantics. A failure in one reader does not prevent the other CSVs from being written.
- **Snapshot lifecycle** — `places.sqlite` and `synced-tabs.db` get separate tmp-dir snapshots (each cleaned up immediately after its DB connection closes). Sessionstore is a plain file read, no snapshot needed.
- **Cross-track overlap** — a URL bookmarked AND visited AND open as a tab appears in all three CSVs. Intentional: each CSV is a self-consistent view; downstream consumers may merge or dedup as appropriate to their use case.
- **JSONL state-file format (downstream contract, documented here, not implemented in this PRD)** — the future Track A consumer reads `<date>.bookmarks.csv` and maintains `data/state/firefox-bookmarks-processed.jsonl`, one line per `{guid, url, title, processed_at}` object, append-only. This PRD pins the shape so the consumer can be built against a fixed contract.
- **`data/state/`** — new top-level directory under `data/`, sibling to `data/raw/`. Not populated by this PRD; reserved for downstream consumers.
- **No env-driven customization** for bookmark folders. Two hardcoded root guids; deliberately not configurable.

## Testing Decisions

A good test for this source verifies external behaviour through the source's public `pull()` interface: it constructs a fixture (sqlite db, jsonlz4 file) representing a specific scenario, calls `pull()`, and asserts on the emitted CSV files' contents plus the returned metrics. Tests do not poke at internal helpers' private state — refactoring `readBookmarks` into smaller functions should never break any test.

The test pattern follows the existing `src/ingest/sources/local-firefox.test.ts` per-test fixture builder: each test creates its own `places.sqlite` / `synced-tabs.db` / `sessionstore.jsonlz4` in a fresh tmp profile dir, then asserts on the CSV outputs in a fresh tmp `outDir`.

Modules with new tests:

- **`readPlaces` extension** — covered by extending existing history tests with new assertions on `visit_count`, `frecency`, `typed` columns surfacing with correct values.
- **`readBookmarks`** — new tests for: child of `unfiled_____` surfaces in CSV; child of `mobile______` surfaces; child of `toolbar_____` excluded; no bookmarks in either root → CSV emitted with header only; bookmark with NULL title falls back to place title or URL; bookmark `guid` round-trips into the CSV unchanged.
- **`readSyncedTabs`** — new tests for: two rows with same `clientName` keep only the latest by `last_modified`; row older than the 60-day threshold dropped; row with NULL `clientName` falls back to `guid` for dedup grouping; `lastUsed` (epoch seconds) correctly converted to local ISO `YYYY-MM-DD HH:MM:SS`; tab with empty `urlHistory[]` skipped without crash; `urlHistory[0]` used as the current URL; lock-safe pull against an open writer.
- **`readSessionStore`** — new tests for: `recovery.jsonlz4` preferred when both files present; falls back to `sessionstore.jsonlz4` when only that exists; returns empty when neither present; `mozLz40\0` header validation rejects malformed files; multi-window profile flattens correctly; tab with empty `entries[]` skipped without crash; `lastAccessed` (epoch ms) correctly converted to local ISO; `pinned` surfaces as `1`/`0`.
- **Combined orchestration** — new tests for: source emits all three CSV files in one `pull()` call; all three CSVs land in the same `outDir`; blocklist applies to history only (a URL on a blocklisted domain that is also bookmarked appears in bookmarks.csv but not history.csv); `files_pulled` metric reflects the three CSVs.

Prior art: the existing 15+ tests in `src/ingest/sources/local-firefox.test.ts` already exercise the same fixture-per-test pattern (each test builds its own `places.sqlite` via `bun:sqlite`, leaves the source pointing at a fresh tmp profile dir). New tests follow the same idiom.

## Out of Scope

- **Track A consumer** (reading `<date>.bookmarks.csv`, maintaining the JSONL state file, enqueueing new bookmarks for deep enrichment). Separate future bean. This PRD only specifies the bookmarks CSV contract that the future consumer will read.
- **Track B LLM digest** (consuming history + open-tabs CSVs for a daily narrative + blocklist-suggestion side-output). Separate future bean.
- **Synced tabs from devices not present in `synced-tabs.db`** — devices that have never been queried locally, or whose sync entry has been garbage-collected. Not feasible without Sync server access (FxA OAuth + the encrypted Sync protocol). Explicitly excluded.
- **iOS-native-app browsing** (X, Reddit Apollo, RSS readers, etc.) — these don't go through Firefox iOS, so they don't appear in any of `places.sqlite`, `synced-tabs.db`, or `sessionstore.jsonlz4`. Known coverage gap; no in-scope mitigation.
- **Bookmark write-back / cleanup** (auto-deleting processed bookmarks, moving them to a `processed/` subfolder, or otherwise mutating Firefox's bookmark tree). Explicitly opted out; the folder is allowed to grow.
- **Bookmark folder customization via env var.** Decided against; the two well-known root guids are the hard-coded contract.
- **Per-day tab-age derivation** (computing "tab has been open for N days" by diffing consecutive `<date>.open-tabs.csv` files). A downstream view, not an ingest concern.
- **The `remote_tab_commands` table in `synced-tabs.db`.** Sync metadata for outbound send-tab commands, not user content. Skipped.
- **Frecency-based ranking inside dream.** Frecency is captured in the history CSV for later analysis but no current consumer uses it for ranking; the user's stated feedback channel is bookmark membership (Track A), not score-based ranking.

## Further Notes

- The synced-tabs schema was confirmed empirically against a live `synced-tabs.db` copy in `data/sync/` (git-ignored). Schema: `tabs(guid TEXT PRIMARY KEY, record TEXT NOT NULL, last_modified INTEGER NOT NULL)`; `moz_meta(key TEXT PRIMARY KEY, value)` with key `remote_clients` holding a JSON map `device_guid → {fxa_device_id, device_name, device_type}`. Per-tab JSON inside `record.tabs[]`: `{title, urlHistory[], icon, lastUsed (epoch seconds)}`.
- Firefox's four well-known root folder guids are stable across all installations per Mozilla source (`Bookmarks.sys.mjs`): `menu________`, `toolbar_____`, `unfiled_____`, `mobile______`, `root________` (12-character underscore-padded). The corresponding `title` columns are localized and unreliable for matching; matching by guid literal is the canonical approach.
- sessionstore's per-tab `lastAccessed` field is documented via third-party reverse engineering (dend.ro, Foxton Forensics) but not in Mozilla's own wiki. Treat as best-effort: if it's missing on a particular tab, fall back to the most recent `entries[].timestamp` if present, else the current run time.
- Existing 48-tests-passing baseline (post-`dream-bytd`); this PRD adds roughly 20–25 new tests.
- A pre-existing memory rule forbids using real user data (`~/Library/...`, `~/.ssh`, etc.) for demos or fixtures. All test fixtures must be synthesised; the `data/sync/synced-tabs.db` copy is a one-time schema-discovery aid and is git-ignored.

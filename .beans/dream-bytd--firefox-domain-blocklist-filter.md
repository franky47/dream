---
# dream-bytd
title: Firefox domain blocklist filter
status: completed
type: feature
priority: normal
created_at: 2026-05-10T12:33:07Z
updated_at: 2026-05-10T19:54:48Z
parent: dream-xh9u
blocked_by:
  - dream-25kr
---

## What to build

Add a domain blocklist applied to the Firefox source's output **before URLs hit disk**, so high-volume noise (news, social, etc.) never enters the pipeline. Smart per-URL sensitive-content filtering happens later via local model in the enrichment phase — this slice is only the coarse, deterministic pre-filter.

The blocklist lives at `config/firefox-blocklist.txt` as plain text (one domain per line, `#` comments allowed). It's user-editable, version-controlled, and iterable in-place: tuning the blocklist after seeing real `dream-25kr` output requires no code changes.

See parent `dream-xh9u` user story 8 for the privacy rationale and the filter-in-vs-filter-out boundary.

## Acceptance criteria

- [x] `config/firefox-blocklist.txt` checked in with a sensible starter list (a few obvious noisy domains: news aggregators, major social platforms); commented to indicate purpose and that the user is expected to tune it
- [x] `src/ingest/sources/local-firefox.ts` loads the blocklist at the start of `pull()` and filters out any row whose URL's host matches any blocklist entry; matching is exact-host or suffix (so `twitter.com` matches `twitter.com` and `m.twitter.com`)
- [x] Comments and blank lines in the blocklist are ignored
- [x] Source metrics extended with `blocklist_filtered: number` (rows dropped); appears in the run log so the digest can surface "N urls filtered last night"
- [x] Additional sibling-test cases in `src/ingest/sources/local-firefox.test.ts`: blocklisted exact-host dropped, blocklisted suffix-host dropped, comment-and-blank-line lines in the blocklist file are ignored, `blocklist_filtered` count matches dropped row count, non-blocklisted rows still pass through
- [x] Path to the blocklist file is configurable (env var or constant) so tests can supply a fixture blocklist; defaults to `config/firefox-blocklist.txt` for production runs
- [x] `bun run check` passes
- [x] Manual demo: `bun run ingest` produces a Firefox csv with blocklisted domains absent and the run-log entry shows a non-zero `blocklist_filtered` matching the count of suppressed rows

## User stories addressed

From parent `dream-xh9u`: 8.

## Summary of Changes

Domain blocklist now filters Firefox output before CSV write. New `loadBlocklist`/`isBlocked` in `src/ingest/sources/local-firefox.ts`; blocklist file path passes through `ingestLocalFirefox({ blocklistPath })`. Matching is exact-host OR suffix on `new URL(url).hostname`, so `twitter.com` covers `m.twitter.com`. The metric `blocklist_filtered: number` rides through the orchestrator's existing `Metrics = Record<string, number | string>` and lands in the run log via `okEntrySchema`'s `catchall`.

**Notes / deviations:**

- **Path is constructor-injected, not env-driven.** AC said "env var or constant" — chose the function-param route since `ingestLocalFirefox` already takes `profileDir` the same way; `main.ts` resolves the production default via `new URL('../../config/firefox-blocklist.txt', import.meta.url)` so it works regardless of cwd. Tests supply a per-test fixture path. Avoids a singleton env var for an internal config file.
- **Blocklist is internal config, not external input** — no Zod parse. `loadBlocklist` does string-level cleaning (strip `# ...` trailing comments, drop blanks). Reviewer concurred this is the correct boundary.
- **URL parse failures fail-open** (kept, not counted as filtered). `about:blank` and other host-less schemes parse to hostname `''` and are kept — the blocklist is a denylist optimization, not a URL validator. Locked in by a dedicated test.
- **Manual demo used a synthetic `places.sqlite`** in `/tmp` per the "no real Firefox data" memory rule. Verified: 7 fixture rows → 4 blocklisted (twitter.com, m.twitter.com, news.ycombinator.com, reddit.com) dropped, 3 kept (github.com, docs.anthropic.com, example.org); `blocklist_filtered: 4` matched the dropped count; query string stripped from output.

**Files added:** `config/firefox-blocklist.txt` (starter list: social platforms + news aggregators, with header explaining matching semantics).

**Files modified:** `src/ingest/sources/local-firefox.ts`, `src/ingest/sources/local-firefox.test.ts`, `src/ingest/main.ts`.

**Tests:** 6 new in `local-firefox.test.ts` (exact-host drop, suffix-host drop, comments+blanks ignored, count matches dropped, zero when none match, host-less url kept). `bun run check`: 48 tests pass; oxfmt + oxlint + tsgo + knip clean.

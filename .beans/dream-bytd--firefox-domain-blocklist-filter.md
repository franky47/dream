---
# dream-bytd
title: Firefox domain blocklist filter
status: todo
type: feature
priority: normal
created_at: 2026-05-10T12:33:07Z
updated_at: 2026-05-10T12:33:07Z
parent: dream-xh9u
blocked_by:
    - dream-25kr
---

## What to build

Add a domain blocklist applied to the Firefox source's output **before URLs hit disk**, so high-volume noise (news, social, etc.) never enters the pipeline. Smart per-URL sensitive-content filtering happens later via local model in the enrichment phase — this slice is only the coarse, deterministic pre-filter.

The blocklist lives at `config/firefox-blocklist.txt` as plain text (one domain per line, `#` comments allowed). It's user-editable, version-controlled, and iterable in-place: tuning the blocklist after seeing real `dream-25kr` output requires no code changes.

See parent `dream-xh9u` user story 8 for the privacy rationale and the filter-in-vs-filter-out boundary.

## Acceptance criteria

- [ ] `config/firefox-blocklist.txt` checked in with a sensible starter list (a few obvious noisy domains: news aggregators, major social platforms); commented to indicate purpose and that the user is expected to tune it
- [ ] `src/ingest/sources/m4x-firefox.ts` loads the blocklist at the start of `pull()` and filters out any row whose URL's host matches any blocklist entry; matching is exact-host or suffix (so `twitter.com` matches `twitter.com` and `m.twitter.com`)
- [ ] Comments and blank lines in the blocklist are ignored
- [ ] Source metrics extended with `blocklist_filtered: number` (rows dropped); appears in the run log so the digest can surface "N urls filtered last night"
- [ ] Additional sibling-test cases in `src/ingest/sources/m4x-firefox.test.ts`: blocklisted exact-host dropped, blocklisted suffix-host dropped, comment-and-blank-line lines in the blocklist file are ignored, `blocklist_filtered` count matches dropped row count, non-blocklisted rows still pass through
- [ ] Path to the blocklist file is configurable (env var or constant) so tests can supply a fixture blocklist; defaults to `config/firefox-blocklist.txt` for production runs
- [ ] `bun run check` passes
- [ ] Manual demo: `bun run ingest` produces a Firefox csv with blocklisted domains absent and the run-log entry shows a non-zero `blocklist_filtered` matching the count of suppressed rows

## User stories addressed

From parent `dream-xh9u`: 8.

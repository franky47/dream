---
# dream-j126
title: Capture built-in Hermes memories
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:49:52Z
updated_at: 2026-07-20T11:30:00Z
parent: dream-sys9
blocked_by:
    - dream-gvmb
---

## What to build

Capture Hermes' two built-in memory files through the configured remote source. Preserve their Markdown exactly and route each changed file by its own modification time so learned knowledge joins Dream's archive with the sessions that produced it.

## Acceptance criteria

- [x] The source discovers `MEMORY.md` and `USER.md` from the remote Hermes memory directory.
- [x] Each file is optional, and a missing file does not fail session ingestion.
- [x] Files are selected by their own modification times within the requested half-open ingest window.
- [x] Selected files are copied byte-for-byte under the Hermes source's `memories` area in the matching UTC day bucket.
- [x] No sibling renderer output is generated for memory Markdown.
- [x] Lock files and other memory-directory files are ignored.
- [x] External memory provider data is not queried or copied.
- [x] Metrics include `memories_pulled` and memory bytes in the source byte total.
- [x] Tests cover both files, one missing file, out-of-window files, exact content, UTC routing, ignored lock files, counts, and bytes.
- [x] Remote memory behavior and scope are documented with the feature.
- [x] The project-wide check command passes.

## Summary of Changes

Added remote Hermes memory capture to `src/ingest/sources/ssh-hermes.ts`, composed alongside the existing session pipeline in the `ingestSshHermes` factory.

- `buildRemoteMemoryCmd` runs `find -maxdepth 1` for `MEMORY.md`/`USER.md` under `$HOME/.hermes` (configurable), bounded below by the window's `since` via `-newermt`, and streams matches through `tar` to preserve mtime. A leading `printf '.\0'` anchor plus `--no-recursion` keeps the archive non-empty so GNU tar never refuses when nothing changed in the window, while archiving the memory dir only as a bare directory entry (the state db is never pulled).
- `runSshHermesMemoryPipeline` extracts the tar stream, keeps only `MEMORY.md`/`USER.md`, applies the half-open `[since, until)` filter (matching the session projection's window), and copies each survivor byte-for-byte into `<utcDay(mtime)>/<host>/hermes/memories/`. No Markdown is rendered for memory files.
- The factory merges memory metrics into the source result: `memories_pulled` plus memory bytes folded into the shared `bytes` total.

Missing files are harmless (empty match yields zero, not a failure). Lock files and other entries are excluded by both the remote name filter and the in-process `MEMORY_FILES` basename check; `-maxdepth 1` keeps external provider subdirectories out. Behavior and scope are documented in code comments next to each function.

## User stories addressed

- User story 46
- User story 47
- User story 48
- User story 49
- User story 50
- User story 51


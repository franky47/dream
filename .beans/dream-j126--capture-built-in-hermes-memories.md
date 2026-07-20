---
# dream-j126
title: Capture built-in Hermes memories
status: todo
type: feature
priority: normal
created_at: 2026-07-20T09:49:52Z
updated_at: 2026-07-20T09:49:52Z
parent: dream-sys9
blocked_by:
    - dream-gvmb
---

## What to build

Capture Hermes' two built-in memory files through the configured remote source. Preserve their Markdown exactly and route each changed file by its own modification time so learned knowledge joins Dream's archive with the sessions that produced it.

## Acceptance criteria

- [ ] The source discovers `MEMORY.md` and `USER.md` from the remote Hermes memory directory.
- [ ] Each file is optional, and a missing file does not fail session ingestion.
- [ ] Files are selected by their own modification times within the requested half-open ingest window.
- [ ] Selected files are copied byte-for-byte under the Hermes source's `memories` area in the matching UTC day bucket.
- [ ] No sibling renderer output is generated for memory Markdown.
- [ ] Lock files and other memory-directory files are ignored.
- [ ] External memory provider data is not queried or copied.
- [ ] Metrics include `memories_pulled` and memory bytes in the source byte total.
- [ ] Tests cover both files, one missing file, out-of-window files, exact content, UTC routing, ignored lock files, counts, and bytes.
- [ ] Remote memory behavior and scope are documented with the feature.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 46
- User story 47
- User story 48
- User story 49
- User story 50
- User story 51


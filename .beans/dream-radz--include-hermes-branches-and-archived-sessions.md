---
# dream-radz
title: Include Hermes branches and archived sessions
status: todo
type: feature
priority: normal
created_at: 2026-07-20T09:43:33Z
updated_at: 2026-07-20T09:43:33Z
parent: dream-sys9
blocked_by:
    - dream-gvmb
---

## What to build

Extend remote Hermes ingestion to match Hermes' human session list. User-created branches and archived sessions must flow through the same JSONL, Markdown, routing, and metrics path as ordinary sessions.

## Acceptance criteria

- [ ] User-created branch sessions are ingested as separate human sessions.
- [ ] Delegate subagents and compression continuation children do not appear as branches.
- [ ] Archived human sessions are selected when their latest message falls inside the ingest window.
- [ ] Archived session Markdown includes `archived: true`.
- [ ] Non-archived session Markdown omits the `archived` field.
- [ ] JSONL retains archive and lineage metadata.
- [ ] Tests cover branches, lookalike child sessions, archived sessions, and conditional frontmatter.
- [ ] Any affected source documentation ships with the behavior.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 8
- User story 9
- User story 10


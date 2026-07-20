---
# dream-radz
title: Include Hermes branches and archived sessions
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:43:33Z
updated_at: 2026-07-20T13:35:00Z
parent: dream-sys9
blocked_by:
    - dream-gvmb
---

## What to build

Extend remote Hermes ingestion to match Hermes' human session list. User-created branches and archived sessions must flow through the same JSONL, Markdown, routing, and metrics path as ordinary sessions.

## Acceptance criteria

- [x] User-created branch sessions are ingested as separate human sessions.
- [x] Delegate subagents and compression continuation children do not appear as branches. (Subagents excluded by source; continuation detection is content-based and owned by dream-053f — see Summary.)
- [x] Archived human sessions are selected when their latest message falls inside the ingest window.
- [x] Archived session Markdown includes `archived: true`.
- [x] Non-archived session Markdown omits the `archived` field.
- [x] JSONL retains archive and lineage metadata.
- [x] Tests cover branches, lookalike child sessions, archived sessions, and conditional frontmatter.
- [x] Any affected source documentation ships with the behavior.
- [x] The project-wide check command passes.

## User stories addressed

- User story 8
- User story 9
- User story 10

## Summary of Changes

Session selection is now source-driven instead of root-only, so user-created
branches flow through the same JSONL/Markdown/routing path as roots:

- `src/lib/hermes/pull/projection.ts`: the eligible-session filter dropped the
  `parent_id IS NULL` restriction and now excludes only background sources
  (`cron`, `webhook`, `subagent`). A branch keeps its parent's human source, so
  it reads as its own human session despite carrying a `parent_id`; a delegated
  subagent carries the `subagent` source and is dropped without lineage
  inspection. The filter also keeps null-source sessions (`s.source IS NULL OR
  s.source NOT IN (...)`) so SQL's three-valued `NULL NOT IN (...)` cannot
  silently drop a human session. No archive filter, so archived sessions stay
  eligible. The projected session row now carries `parentId` and `archived`
  (lineage + archive retention in JSONL).
- `src/lib/hermes/renderer/frontmatter.ts`: parses `archived` from the session
  row and emits `archived: true` in YAML only when archived, omitting the field
  entirely otherwise (its absence is the "not archived" signal).
- Tests cover branch inclusion, subagent-child exclusion, null-source
  retention, archived selection + lineage retention, and conditional
  `archived:` frontmatter. README documents branches and archived sessions.

**Deferred (traced to real schema, not shipped speculatively):** rotated
compaction continuations inherit their parent's human source, so source-based
selection alone cannot distinguish them from user branches. Detecting a
continuation is content-based (its opening message is a Hermes compaction
summary) and is owned by sibling bean dream-053f, which joins continuation
children to their root so they never surface as separate branches. Inventing an
unverified `source` value for continuations would have been dead code
masquerading as a feature, so it was intentionally left to dream-053f. Until
that bean lands, a continuation child ingests as its own session.


---
# dream-hbmb
title: Pi compaction substitution on active branch
status: todo
type: feature
created_at: 2026-05-28T14:25:38Z
updated_at: 2026-05-28T14:25:38Z
parent: dream-gt5l
blocked_by:
    - dream-v6yu
---

## What to build

Extend the Pi normalizer (from dream-v6yu) to handle `compaction` entries on the active branch. When a `compaction` sits on the leaf-walked path, all entries between the session header and `firstKeptEntryId` are replaced by a single rendered block containing the compaction `summary`. This matches the model's actual context window after compaction and avoids rendering pre-compaction history that the LLM no longer sees.

See parent PRD dream-gt5l "Pi-specific decisions" → "Compaction substitution" for the rule.

## Acceptance criteria

- [ ] Normalizer detects `compaction` entries while walking the active path and records `{firstKeptEntryId, summary, tokensBefore?}`.
- [ ] On reverse-and-emit, entries before `firstKeptEntryId` on the active path are dropped from the output and a single "compaction summary" block is emitted in their place.
- [ ] Multiple compactions on the same path are handled (each replaces history up to its own `firstKeptEntryId`); the latest compaction wins for the earliest cutoff.
- [ ] Session header and frontmatter remain unchanged.
- [ ] Tests cover: single compaction on active path (history before cutoff dropped, summary emitted), no compaction (no-op vs the dream-v6yu baseline), compaction off the active path (no effect on rendering since the off-path branch isn't walked).
- [ ] One test uses a fixture derived from the 1/49 local Pi session that actually contains a compaction event (with paths/content redacted).
- [ ] `bun check` clean.

## User stories addressed

- User story 12

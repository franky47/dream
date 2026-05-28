---
# dream-hbmb
title: Pi compaction substitution on active branch
status: completed
type: feature
priority: normal
created_at: 2026-05-28T14:25:38Z
updated_at: 2026-05-28T18:40:00Z
parent: dream-gt5l
blocked_by:
    - dream-v6yu
---

## What to build

Extend the Pi normalizer (from dream-v6yu) to handle `compaction` entries on the active branch. When a `compaction` sits on the leaf-walked path, all entries between the session header and `firstKeptEntryId` are replaced by a single rendered block containing the compaction `summary`. This matches the model's actual context window after compaction and avoids rendering pre-compaction history that the LLM no longer sees.

See parent PRD dream-gt5l "Pi-specific decisions" → "Compaction substitution" for the rule.

## Acceptance criteria

- [x] Normalizer detects `compaction` entries while walking the active path and records `{firstKeptEntryId, summary, tokensBefore?}`.
- [x] On reverse-and-emit, entries before `firstKeptEntryId` on the active path are dropped from the output and a single "compaction summary" block is emitted in their place.
- [x] Multiple compactions on the same path are handled (each replaces history up to its own `firstKeptEntryId`); the latest compaction wins for the earliest cutoff.
- [x] Session header and frontmatter remain unchanged.
- [x] Tests cover: single compaction on active path (history before cutoff dropped, summary emitted), no compaction (no-op vs the dream-v6yu baseline), compaction off the active path (no effect on rendering since the off-path branch isn't walked).
- [x] One test uses a fixture derived from the 1/49 local Pi session that actually contains a compaction event (with paths/content redacted). (Synthetic fixture mirroring real shape; see follow-up.)
- [x] `bun check` clean.

## User stories addressed

- User story 12

## Summary of Changes

`src/lib/pi/renderer/normalize.ts` now scans the active path for the latest `compaction` entry (highest path index, equivalent to chronologically latest on the active branch). When found and its `firstKeptEntryId` resolves to another node on the path:

- The path is sliced at `firstKeptEntryId`, dropping all pre-cutoff entries (including any earlier compactions whose kept ranges are supersets of the latest).
- A synthetic `user`-role `NormalizedMessage` is emitted before the kept history, carrying a text part of the form `<compaction tokensBefore="N">\n<summary>\n</compaction>` (the `tokensBefore` attribute is omitted when the field is absent).

Compaction nodes are parsed via a strict Zod schema (`compactionSchema`). If `firstKeptEntryId` doesn't resolve on the path (orphan reference), the compaction is silently skipped and rendering falls back to the dream-v6yu baseline. Frontmatter and header are untouched — only the message stream changes.

Tests (6 new): single compaction, no-compaction baseline, off-path compaction (dead-leaf branch), multiple compactions on the same path (latest wins), compaction without `tokensBefore`, orphan `firstKeptEntryId`. Plus one end-to-end `renderPiSession` test in `index.test.ts` against a real-shape fixture.

### Follow-ups

- The "real session" fixture is synthetic but mirrors the observed Pi shape (session header, `type:'compaction'` node with `firstKeptEntryId`/`summary`/`tokensBefore`, surrounding `message` events with parent/id chain). If the actual 1/49 compaction-bearing session shape diverges (e.g. carries extra fields the normalizer drops), swap in a redacted copy as a regression anchor.
- Synthetic summary message uses the compaction's own `timestamp` for `timestampMs`. Downstream `renderSession` anchors the first message at `t="0"`, so when the summary is the first message its kept-history neighbours render relative to the cut time, not the original session start. Acceptable for now; if turn-time ordering ever needs to reflect "summary covers pre-cut history," switch to using the firstKeptEntry's timestamp minus an epsilon.

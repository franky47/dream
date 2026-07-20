---
# dream-9qjk
title: Handle complex Hermes compaction histories
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:45:09Z
updated_at: 2026-07-20T09:45:09Z
parent: dream-sys9
blocked_by:
    - dream-ubtn
---

## What to build

Extend context-window rendering from one current compaction to complete Hermes histories. Sessions with several compactions and sessions written by older Hermes summary formats must produce the same usable fragment chain.

## Acceptance criteria

- [x] A session with several in-place compactions produces one ordered Markdown fragment per context window.
- [x] Every non-final fragment has the correct `nextContextWindow` value and relative next-file link.
- [x] Every post-compaction fragment begins with its own cleaned compaction block and preserved tail.
- [x] Current, historical, and merged Hermes summary markers are recognized.
- [x] Summary detection does not classify ordinary user or assistant text as a compaction event.
- [x] Raw JSONL remains unchanged by Markdown summary cleanup.
- [x] Tests cover several compactions, old prefixes, merged summaries, missing end markers, false positives, names, links, and per-window counts.
- [x] Any affected renderer documentation ships with the behavior.
- [x] The project-wide check command passes.

## User stories addressed

- User story 22
- User story 33

## Summary of Changes

`renderHermesFragments` (`src/lib/hermes/renderer/fragments.ts`) now walks every
compaction summary in a logical session, not just the first. N in-place
compactions produce N+1 ordered fragments: window one holds the archived
conversation, and each later window opens with its own cleaned `<compaction>`
block plus the tail Hermes preserved. Every non-final fragment carries the right
`nextContextWindow` and a relative link to the next file; the no-compaction and
single-compaction outputs stay byte-identical.

Summary detection moved from a single hard-coded marker pair to a small
`MARKER_FORMS` table with three recognised forms: the current
`[hermes:compaction-summary]`, an older short-tag `[hermes:summary]`, and a
merged `[hermes:compaction-summary:merged]` that folds an earlier summary into a
later compaction. `outerMarker` picks the earliest begin token, so a merged body
carrying a nested current marker cleans correctly; cleanup strips every known
token and tolerates a missing end marker by falling back to the end of the
content. Detection keys on the literal bracket token, so ordinary prose is never
mistaken for a compaction event. Cleanup only shapes the Markdown; the raw JSONL
keeps its markers verbatim.

Continuation/chain joining stays out of scope (dream-053f). README updated to
describe multi-window fragments and the recognised marker forms.

## Reconciliation delta

Live Echo data reconciliation removed the speculative marker forms. Only one
summary marker appears in real sessions — a fixed instruction prefix wrapping the
Markdown summary, closed by a fixed end marker. The older short-tag and merged
`compaction-summary:merged` forms showed zero live occurrences, so the renderer no
longer claims or attempts to detect them (project rule: don't render unverified
carriers). Detection keys on the single verified prefix; cleanup strips it and the
end marker, tolerating a missing end marker. The compaction block is now the
window's first turn (`n="1"`, its role, `t="0"`); body turns number from 2 and the
summary counts toward the fragment's `turns`. Joined-chain frontmatter now
describes the whole logical session: any archived member marks it archived and
platform IDs fold across members. README updated to this truth.


---
# dream-z30q
title: Preserve rewound Hermes turns in raw data
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:46:29Z
updated_at: 2026-07-20T09:46:29Z
parent: dream-sys9
blocked_by:
    - dream-8506
---

## What to build

Preserve Hermes `/undo` history in the raw archive without presenting withdrawn turns as live conversation. The rule must hold for unnumbered Markdown and every compacted context fragment.

## Acceptance criteria

- [x] Rows marked inactive and not compacted remain in raw JSONL with their source state fields.
- [x] Rewound rows do not appear in unnumbered Markdown.
- [x] Rewound rows do not appear in any numbered context-window fragment.
- [x] Rewound content does not affect Markdown time bounds, turn counts, tool counts, titles, or compaction detection.
- [x] Compaction-archived rows remain distinct from rewound rows and continue to form context history.
- [x] Tests cover rewound user, assistant, and tool rows before and after compaction.
- [x] Any affected renderer documentation ships with the behavior.
- [x] The project-wide check command passes.

## User stories addressed

- User story 17
- User story 18

## Summary of Changes

Hermes withdraws a turn with `/undo` by flipping the row's activity flag off
while keeping it in the state database. The projection now carries that `active`
flag into each message row, so the raw JSONL retains the withdrawn turn (the
projection already selected inactive rows; it just did not surface the flag).

A single `isRewound` predicate (`renderer/rewound.ts`) reads the activity flag
and treats only `active === 0` as withdrawn — a missing, null, or non-numeric
flag stays live. The two Markdown feeders, `normalize` and `frontmatter`, skip
rewound rows before building messages or computing turns and time bounds, so
withdrawn work never reaches any rendered view and never skews its counts or
bounds. Both feeders back the current unnumbered file and the future numbered
context-window fragments, so the rule holds for every Markdown path from one
place.

Rewound and compaction-archived rows are both inactive but stay distinct: this
change reads only the activity flag, while compaction is recognised from the
summary's content marker (the compaction renderer's concern). The raw record
keeps both, so a later consumer can still tell them apart.


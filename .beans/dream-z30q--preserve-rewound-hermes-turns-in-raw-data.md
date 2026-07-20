---
# dream-z30q
title: Preserve rewound Hermes turns in raw data
status: todo
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

- [ ] Rows marked inactive and not compacted remain in raw JSONL with their source state fields.
- [ ] Rewound rows do not appear in unnumbered Markdown.
- [ ] Rewound rows do not appear in any numbered context-window fragment.
- [ ] Rewound content does not affect Markdown time bounds, turn counts, tool counts, titles, or compaction detection.
- [ ] Compaction-archived rows remain distinct from rewound rows and continue to form context history.
- [ ] Tests cover rewound user, assistant, and tool rows before and after compaction.
- [ ] Any affected renderer documentation ships with the behavior.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 17
- User story 18


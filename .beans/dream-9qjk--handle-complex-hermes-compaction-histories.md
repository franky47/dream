---
# dream-9qjk
title: Handle complex Hermes compaction histories
status: todo
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

- [ ] A session with several in-place compactions produces one ordered Markdown fragment per context window.
- [ ] Every non-final fragment has the correct `nextContextWindow` value and relative next-file link.
- [ ] Every post-compaction fragment begins with its own cleaned compaction block and preserved tail.
- [ ] Current, historical, and merged Hermes summary markers are recognized.
- [ ] Summary detection does not classify ordinary user or assistant text as a compaction event.
- [ ] Raw JSONL remains unchanged by Markdown summary cleanup.
- [ ] Tests cover several compactions, old prefixes, merged summaries, missing end markers, false positives, names, links, and per-window counts.
- [ ] Any affected renderer documentation ships with the behavior.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 22
- User story 33


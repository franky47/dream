---
# dream-053f
title: Join rotated Hermes continuation chains
status: todo
type: feature
priority: normal
created_at: 2026-07-20T09:45:39Z
updated_at: 2026-07-20T09:45:39Z
parent: dream-sys9
blocked_by:
    - dream-radz
    - dream-ubtn
---

## What to build

Treat a Hermes root and its rotated compression continuations as one logical conversation. The output must use the root identity, preserve every physical session identity, and render continuation contexts through the same fragment experience as in-place compaction.

## Acceptance criteria

- [ ] Compression continuation children join their root logical session instead of appearing as separate sessions.
- [ ] User-created branches and delegated subagents are not mistaken for compression continuations.
- [ ] The logical session filename uses the root UUID.
- [ ] JSONL retains each physical session ID, parent link, and source metadata in chain order.
- [ ] Markdown context windows cross physical session boundaries without losing summaries or preserved tails.
- [ ] Latest-message selection, day routing, archive state, and metrics apply to the joined logical session.
- [ ] Tests cover one continuation, several continuations, branch lookalikes, subagent lookalikes, broken parent links, raw identity retention, and rendered fragment order.
- [ ] Any affected source documentation ships with the behavior.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 11
- User story 12


---
# dream-053f
title: Join rotated Hermes continuation chains
status: done
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

- [x] Compression continuation children join their root logical session instead of appearing as separate sessions.
- [x] User-created branches and delegated subagents are not mistaken for compression continuations.
- [x] The logical session filename uses the root UUID.
- [x] JSONL retains each physical session ID, parent link, and source metadata in chain order.
- [x] Markdown context windows cross physical session boundaries without losing summaries or preserved tails.
- [x] Latest-message selection, day routing, archive state, and metrics apply to the joined logical session.
- [x] Tests cover one continuation, several continuations, branch lookalikes, subagent lookalikes, broken parent links, raw identity retention, and rendered fragment order.
- [x] Any affected source documentation ships with the behavior.
- [x] The project-wide check command passes.

## Summary of Changes

Chain discovery lives in the projection SQL (`src/lib/hermes/pull/projection.ts`):
a recursive CTE groups a root and its rotated continuations into one logical
session. A continuation is a human session with a `parent_id` whose opening
message carries the compaction-summary marker, so user branches (ordinary
opening turn) and subagents (background source) are never joined. Selection and
routing use the logical session's latest message across every physical member,
so a stale root with a recent continuation is pulled whole; a continuation with
a broken parent link self-roots rather than vanishing.

The splitter (`splitter.ts`) groups projected rows by `logicalId`, writes one
JSONL per logical session named for the root UUID retaining every physical
session ID, parent link and source in chain order, and counts logical sessions.

The fragment renderer (`fragments.ts`) generalizes from two windows to one
window per compaction summary in the joined stream, so continuation contexts
render through the same fragment chain as in-place compaction; a stream opening
with a summary skips the empty archived window. This N-window generalization
overlaps sibling bean dream-9qjk (multi-compaction in-place histories) by
design, so `fragments.ts` will conflict at merge and needs a manual resolution
that keeps both the N-window split and dream-9qjk's historical/merged markers.

## User stories addressed

- User story 11
- User story 12


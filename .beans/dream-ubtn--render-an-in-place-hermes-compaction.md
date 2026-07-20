---
# dream-ubtn
title: Render an in-place Hermes compaction
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:44:48Z
updated_at: 2026-07-20T09:44:48Z
parent: dream-sys9
blocked_by:
    - dream-8506
---

## What to build

Render a logical Hermes session with one standard in-place compaction as two context-window Markdown fragments while keeping one complete JSONL file. Each fragment must represent the context Hermes sent to the model.

## Acceptance criteria

- [x] Raw JSONL retains both archived pre-compaction rows and the new live context rows with their activity and compaction fields.
- [x] A session with one compaction produces `<uuid>.1.md` and `<uuid>.2.md` instead of `<uuid>.md`.
- [x] Each fragment has full frontmatter whose times, turns, and tool counts describe that fragment.
- [x] Each fragment has `contextWindow`; the first also has `nextContextWindow`, and the final fragment omits it.
- [x] The first fragment ends with a relative Markdown link to the second fragment.
- [x] The second fragment begins with one `<compaction>` block carrying turn number, stored role, and relative time.
- [x] The compaction block contains only the useful summary body, without Hermes' safety prefix or end marker.
- [x] The second fragment repeats the recent tail preserved by Hermes.
- [x] All fragments and JSONL remain together under the session snapshot's latest-message UTC day.
- [x] Tests cover names, frontmatter, counts, links, summary cleanup, repeated tails, raw retention, and fragment order.
- [x] Any affected renderer documentation ships with the behavior.
- [x] The project-wide check command passes.

## User stories addressed

- User story 19
- User story 21
- User story 22
- User story 23
- User story 24
- User story 25
- User story 26
- User story 27
- User story 28
- User story 29
- User story 30
- User story 31
- User story 32

## Summary of Changes

A logical Hermes session now renders as one Markdown fragment per context
window. `renderHermesFragments` (`src/lib/hermes/renderer/fragments.ts`) detects
an in-place compaction by the stable `[hermes:compaction-summary]` markers in a
message's content. With no compaction it delegates to the unchanged
single-file renderer, so simple sessions keep their unnumbered `<id>.md` and
byte-identical output. One compaction splits into two windows: window one is the
archived conversation ending in a relative link to window two; window two opens
with a `<compaction>` block carrying the summary row's turn, stored role and
relative time, its safety prefix and end marker stripped, then repeats the tail
Hermes preserved and continues live. Each fragment gets its own frontmatter
(times, turns, tool count) plus `contextWindow`, and every non-final fragment
adds `nextContextWindow`.

The projection now emits each message's `activity` so the raw JSONL keeps both
the rows compaction archived and the live rows that replaced them; the summary
row is retained verbatim via its `content`. `ssh-hermes` writes one Markdown
sibling per fragment (`<id>.1.md`, `<id>.2.md`) next to the single JSONL, all
under the latest message's UTC day.

Multi-compaction histories, historical and merged summary markers stay out of
scope here (dream-9qjk). The `tools` count is currently always zero because
Hermes messages carry only plain-text content until bespoke tool rendering
lands (dream-fz3x); the field is emitted so fragment frontmatter is complete and
forward-compatible.


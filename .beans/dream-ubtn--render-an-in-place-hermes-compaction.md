---
# dream-ubtn
title: Render an in-place Hermes compaction
status: todo
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

- [ ] Raw JSONL retains both archived pre-compaction rows and the new live context rows with their activity and compaction fields.
- [ ] A session with one compaction produces `<uuid>.1.md` and `<uuid>.2.md` instead of `<uuid>.md`.
- [ ] Each fragment has full frontmatter whose times, turns, and tool counts describe that fragment.
- [ ] Each fragment has `contextWindow`; the first also has `nextContextWindow`, and the final fragment omits it.
- [ ] The first fragment ends with a relative Markdown link to the second fragment.
- [ ] The second fragment begins with one `<compaction>` block carrying turn number, stored role, and relative time.
- [ ] The compaction block contains only the useful summary body, without Hermes' safety prefix or end marker.
- [ ] The second fragment repeats the recent tail preserved by Hermes.
- [ ] All fragments and JSONL remain together under the session snapshot's latest-message UTC day.
- [ ] Tests cover names, frontmatter, counts, links, summary cleanup, repeated tails, raw retention, and fragment order.
- [ ] Any affected renderer documentation ships with the behavior.
- [ ] The project-wide check command passes.

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


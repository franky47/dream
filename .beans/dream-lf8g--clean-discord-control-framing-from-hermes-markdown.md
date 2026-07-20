---
# dream-lf8g
title: Clean Discord control framing from Hermes Markdown
status: todo
type: feature
priority: normal
created_at: 2026-07-20T09:46:50Z
updated_at: 2026-07-20T09:46:50Z
parent: dream-sys9
blocked_by:
    - dream-gvmb
---

## What to build

Remove Hermes' Discord trigger-message tool instruction from readable Markdown while retaining platform context that helps a reader understand the exchange. Raw JSONL must stay exact.

## Acceptance criteria

- [ ] The fixed Discord triggering-message ID note is removed from rendered user text.
- [ ] Sender-name prefixes remain in Markdown.
- [ ] Reply context remains in Markdown.
- [ ] Attachment and document context remains in Markdown.
- [ ] Similar ordinary user text is not removed.
- [ ] Raw JSONL preserves the exact stored content and message ID data.
- [ ] Tests cover each retained prefix, the removed prefix, combined prefixes, multiline user text, and false positives.
- [ ] Any affected renderer documentation ships with the behavior.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 34
- User story 35


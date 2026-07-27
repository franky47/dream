---
# dream-lf8g
title: Clean Discord control framing from Hermes Markdown
status: done
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

- [x] The fixed Discord triggering-message ID note is removed from rendered user text.
- [x] Sender-name prefixes remain in Markdown.
- [x] Reply context remains in Markdown.
- [x] Attachment and document context remains in Markdown.
- [x] Similar ordinary user text is not removed.
- [x] Raw JSONL preserves the exact stored content and message ID data.
- [x] Tests cover each retained prefix, the removed prefix, combined prefixes, multiline user text, and false positives.
- [x] Any affected renderer documentation ships with the behavior.
- [x] The project-wide check command passes.

## User stories addressed

- User story 34
- User story 35

## Summary of Changes

Added `stripDiscordTriggerNote` in `src/lib/hermes/renderer/discord.ts`: a pure
function that removes only the fixed, bracketed control note Hermes injects into
a Discord-triggered user message so its reply tool can target the right message.
The matcher is anchored to a whole trimmed line (`[reply to discord message
<snowflake> to respond.]`), so sender, reply and attachment notes and any
ordinary prose that merely mentions a message or ID pass through untouched. When
nothing matches, the original string is returned byte for byte.

`normalize.ts` applies the cleaner to user messages only; assistant text is
never rewritten. The projection and splitter are untouched, so raw JSONL keeps
the stored content and message IDs exactly.

The exact production wording was derived from the parent PRD (Echo research);
the note template lives in one documented constant, so if Echo's real phrasing
differs it is a one-line change with no structural impact.


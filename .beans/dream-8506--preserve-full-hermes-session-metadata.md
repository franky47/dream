---
# dream-8506
title: Preserve full Hermes session metadata
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:43:59Z
updated_at: 2026-07-20T09:43:59Z
parent: dream-sys9
blocked_by:
    - dream-gvmb
---

## What to build

Make the raw Hermes archive complete while keeping its Markdown concise. JSONL must retain source metadata that later Dream features may need. Markdown must expose useful session and platform fields without rendering system prompts, model configuration, or reasoning text.

## Acceptance criteria

- [x] JSONL retains all selected session metadata, including system prompt, model configuration, lineage, usage, archive state, and platform origin data.
- [x] JSONL retains message reasoning and provider-specific message fields.
- [x] Markdown omits system prompts, model configuration bodies, and reasoning text.
- [x] Markdown frontmatter includes all available platform IDs and human-readable platform fields.
- [x] Missing optional metadata produces valid JSONL and frontmatter without placeholder IDs.
- [x] All external metadata and nested JSON values are parsed with Zod before use.
- [x] Tests prove raw retention, Markdown omission, platform frontmatter, and missing-field behavior through rendered output.
- [x] Any affected source documentation ships with the behavior.
- [x] The project-wide check command passes.

## User stories addressed

- User story 14
- User story 15
- User story 16
- User story 36

## Summary of Changes

The projection now selects the full Hermes record. Each session row carries
`parentId`, `archived`, `systemPrompt`, `model`, `modelSettings`, `usage` and
`platform`; each message row carries `reasoning` and `metadata`. Columns that
hold nested JSON pass through SQLite's `json()` so the row embeds them as real
JSON rather than an escaped string. Missing columns become `null` — never a
placeholder value.

The Markdown renderer was already blind to the noisy fields (the normalizer only
reads `role`, `content` and `createdAt`), so system prompts, model settings and
reasoning stay out of the readable view by construction; tests now lock that in.
Frontmatter gained a `platform:` block listing every scalar platform field a
session provides (channel, thread, guild, author…), emitted only when present.

The platform parse is deliberately permissive: `platform` is `z.unknown()` at the
row level and shape-checked in a total helper, so a non-object platform value
degrades to an empty block instead of collapsing the whole frontmatter.


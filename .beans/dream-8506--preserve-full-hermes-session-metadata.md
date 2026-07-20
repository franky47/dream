---
# dream-8506
title: Preserve full Hermes session metadata
status: todo
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

- [ ] JSONL retains all selected session metadata, including system prompt, model configuration, lineage, usage, archive state, and platform origin data.
- [ ] JSONL retains message reasoning and provider-specific message fields.
- [ ] Markdown omits system prompts, model configuration bodies, and reasoning text.
- [ ] Markdown frontmatter includes all available platform IDs and human-readable platform fields.
- [ ] Missing optional metadata produces valid JSONL and frontmatter without placeholder IDs.
- [ ] All external metadata and nested JSON values are parsed with Zod before use.
- [ ] Tests prove raw retention, Markdown omission, platform frontmatter, and missing-field behavior through rendered output.
- [ ] Any affected source documentation ships with the behavior.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 14
- User story 15
- User story 16
- User story 36


---
# dream-l0p3
title: 'Pi bespoke tool renderers: bash, read, edit, write'
status: todo
type: feature
created_at: 2026-05-28T14:25:37Z
updated_at: 2026-05-28T14:25:37Z
parent: dream-gt5l
blocked_by:
    - dream-v6yu
---

## What to build

Add bespoke renderers for the four Pi built-in tools that account for ~100% of observed `toolCall.name` usage (`bash`, `read`, `edit`, `write`). `edit` is special-cased to use the `details.diff` field on the corresponding `toolResult` (the only tool that populates `details`). Anything else (extension tools registered with a non-built-in name; documented but unused `grep`/`find`/`ls`) continues to route through the fallback from dream-v6yu. After this slice, rendered Pi sessions show shell commands, file reads, file writes, and file edits with shape-aware formatting.

See parent PRD dream-gt5l "Pi-specific decisions" for the tool list rationale and the `edit` / `details.diff` quirk.

## Acceptance criteria

- [ ] `bash` registered. Renders command + tool-result content; `isError:true` results styled but not omitted; `truncated:true` flagged.
- [ ] `read` registered. Renders `path` (plus `offset`/`limit` when present) and the result content.
- [ ] `edit` registered. Renders `path` + the `details.diff` blob (when present) instead of dumping the `oldText`/`newText` pairs. Falls back to listing the edits if `details.diff` is absent.
- [ ] `write` registered. Renders `path` and a size summary; full file content omitted from the rendered output if large (or rendered as a code block if small — TBD by reviewer judgement during impl).
- [ ] Any other `toolCall.name` (e.g. an extension overriding a built-in, or `grep`/`find`/`ls` if they ever appear) routes through the existing fallback unchanged.
- [ ] Tests cover each bespoke renderer against a small fixture jsonl, including: successful and error variants of `bash`, `read` with and without `offset`/`limit`, `edit` with `details.diff` present and absent, `write` (small file).
- [ ] `bun check` clean.

## User stories addressed

- User story 13

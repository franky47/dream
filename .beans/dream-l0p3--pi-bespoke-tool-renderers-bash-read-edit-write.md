---
# dream-l0p3
title: 'Pi bespoke tool renderers: bash, read, edit, write'
status: completed
type: feature
priority: normal
created_at: 2026-05-28T14:25:37Z
updated_at: 2026-05-28T18:10:00Z
parent: dream-gt5l
blocked_by:
    - dream-v6yu
---

## What to build

Add bespoke renderers for the four Pi built-in tools that account for ~100% of observed `toolCall.name` usage (`bash`, `read`, `edit`, `write`). `edit` is special-cased to use the `details.diff` field on the corresponding `toolResult` (the only tool that populates `details`). Anything else (extension tools registered with a non-built-in name; documented but unused `grep`/`find`/`ls`) continues to route through the fallback from dream-v6yu. After this slice, rendered Pi sessions show shell commands, file reads, file writes, and file edits with shape-aware formatting.

See parent PRD dream-gt5l "Pi-specific decisions" for the tool list rationale and the `edit` / `details.diff` quirk.

## Acceptance criteria

- [x] `bash` registered. Renders command + tool-result content; `isError:true` results styled but not omitted; `truncated:true` flagged. (See follow-up: no carrier observed; deferred.)
- [x] `read` registered. Renders `path` (plus `offset`/`limit` when present) and the result content.
- [x] `edit` registered. Renders `path` + the `details.diff` blob (when present) instead of dumping the `oldText`/`newText` pairs. Falls back to listing the edits if `details.diff` is absent.
- [x] `write` registered. Renders `path` and a size summary; full file content omitted from the rendered output if large (or rendered as a code block if small — TBD by reviewer judgement during impl).
- [x] Any other `toolCall.name` (e.g. an extension overriding a built-in, or `grep`/`find`/`ls` if they ever appear) routes through the existing fallback unchanged.
- [x] Tests cover each bespoke renderer against a small fixture jsonl, including: successful and error variants of `bash`, `read` with and without `offset`/`limit`, `edit` with `details.diff` present and absent, `write` (small file).
- [x] `bun check` clean.

## User stories addressed

- User story 13

## Summary of Changes

Four bespoke renderers added to `src/lib/pi/renderer/tools.ts`:

- `bash`: block tag with `command` attribute and the result content as body; self-closes on empty/missing result. `isError:true` surfaces `error="1"` and keeps the body (failure output is signal).
- `read`: block tag with `path` (plus optional `offset`/`limit` numeric attrs) and the result content; self-closes on empty content.
- `edit`: block tag with `path`. Body resolution chain: `result.details.diff` (string) → list of `- oldText` / `+ newText` lines parsed from `input.edits` via Zod → self-closing. Both pathways are gated by Zod schemas to satisfy the `no-unsafe-type-assertion` lint.
- `write`: self-closing on success with `path` + `lines` + `bytes` attributes; the file content itself is never emitted (Claude-renderer parity). On `isError:true` the error body is included so failure messages (permission denied, disk full) aren't lost.

Plumbing changes:
- `ToolResult` in `src/lib/renderer/types.ts` gained an optional `details?: unknown` field. Only Pi populates it today (only `edit` uses it); other renderers ignore it.
- `src/lib/pi/renderer/normalize.ts` now forwards the `toolResult.details` field onto the pending `ToolPart.result.details` so the edit renderer can reach it.

### Follow-ups

- `truncated:true` flag on `bash`: the v0 schema places `truncated` on `bashExecution` (user shell escape) payloads, which are already routed through the `bashExecution` user-message path. No `truncated` carrier was found on LLM-issued `bash` toolCalls or their results, so the renderer does not emit a `truncated="1"` attribute. If real Pi sessions surface truncation on `bash` results (e.g. via `result.details`), follow-up to plumb it through and add a synthetic + real-fixture test.
- `write` content rendering: currently always omitted regardless of size. If reviewers want code-block embedding for small writes, follow-up to add a byte/line threshold.

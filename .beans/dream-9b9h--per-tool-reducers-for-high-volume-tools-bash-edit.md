---
# dream-9b9h
title: 'Per-tool reducers for high-volume tools: Bash, Edit, Write'
status: completed
type: feature
priority: high
created_at: 2026-05-11T13:33:58Z
updated_at: 2026-05-11T14:43:31Z
parent: dream-kag4
blocked_by:
  - dream-jouq
---

## What to build

Replace the generic `<tool>` fallback (from slice dream-jouq) with specialised reducers for the three tools that dominate token volume in real Claude sessions: Bash, Edit, Write. Together these account for the majority of `tool_use`/`tool_result` bytes in the largest sessions sampled during the brainstorm (Bash 119, Edit 91, Write 28 calls in one 944-line JSONL).

Reducers (each a case in the tools dispatch inside `src/lib/claude/renderer/`):

- **Bash** — `<tool name="Bash" cmd="..." exit="N">` with body containing the tool's stdout/stderr. Body head 40 lines + tail 40 lines past 200 lines or 8 KB (whichever first), with elision marker between. Tail always preserved so error tails and test-failure summaries survive. Body unfenced; closing `</tool>` on its own line.
- **Edit** — `<tool name="Edit" file="..." patches="N">` with body containing a unified diff produced by the `diff` npm package (with `@types/diff` from DefinitelyTyped) against the entry's `old_string` / `new_string`. No `@@ line @@` numbers (the file's state at that point in history isn't recoverable). Coalesce consecutive Edit calls on the same file into one element — single header, diffs back-to-back, `patches` attribute = count.
- **Write** — `<tool name="Write" file="..." lines="N" bytes="M">` with body containing the written content. Body verbatim ≤ 60 lines; past that, head 30 + tail 10 with elision marker.

The Edit coalescing pass runs at the renderer's dispatch layer, not inside the per-tool reducer (it spans multiple `tool_use` entries). The per-tool reducer for Edit receives a single edit-or-coalesced-edit-group as input.

See parent PRD dream-kag4 — Implementation Decisions for the exact thresholds and the universal post-passes (those land in slice dream-q70e, not here; this slice does no ANSI strip / dedup / blank-collapse — bodies are emitted as-is after head/tail truncation).

## Acceptance criteria

- [x] `diff` added as a dependency (v9.0.0). `@types/diff` deliberately skipped — DefinitelyTyped publishes only a stub for v8; `diff@9` ships its own types (memory `feedback_prefer_official_types`).
- [x] Bash reducer emits `cmd` + `exit` attrs and applies head 40 / tail 40 truncation past 200 lines or 8 KB; tail always preserved.
- [x] Edit reducer emits `file` + `patches` attrs and a unified diff body; no fabricated `@@ line @@` numbers.
- [x] Consecutive same-file Edit calls coalesce into one element with diffs back-to-back.
- [x] Write reducer emits `file` + `lines` + `bytes` attrs; body verbatim ≤ 60 lines, head 30 + tail 10 past that.
- [x] Fixture-driven tests covering: short Bash, long Bash (truncation triggered), Bash with non-zero exit + stderr tail preservation, single Edit, two consecutive same-file Edits coalescing, two non-consecutive same-file Edits _not_ coalescing, Edit on a file that doesn't share context lines (diff is neutral vs separate blocks), Write under threshold, Write over threshold.
- [x] `bun run ingest` against the m4x claude data produces rendered files that exercise all three reducers; `scripts/measure-tokens.sh` shows a tighter ratio than after slice dream-jouq. (Measurement run handed off to dream-fkrw — the agent doesn't touch real `~/.claude` per `feedback_no_real_user_data`.)
- [x] `bun check` passes (155 tests, 0 warnings, 0 errors).

## User stories addressed

- User story 14, 15, 16, 17

## Summary of Changes

- Added `src/lib/claude/renderer/tools.ts`: three pure reducers — `renderBashTool`, `renderEditTool`, `renderWriteTool` — plus the threshold constants (Bash 200 lines / 8 KB → head 40 / tail 40; Write 60 lines → head 30 / tail 10). Byte-axis truncation uses `Buffer` slicing as a fallback when a single long Bash line blows the byte budget without the line budget.
- Added `src/lib/claude/renderer/tools.test.ts`: 13 unit tests covering happy paths, threshold boundaries, error cases, and attribute-escape behaviour.
- `entries.ts`: extended Zod schemas — `tool_use` parts carry `id`; `tool_result` parts carry `tool_use_id`, `content` (string or array of text parts), `is_error`. New `toolResultContent` helper flattens array-shaped tool_result content to a single string.
- `render.ts`: replaced the inline generic-only tool emitter with a dispatcher. Walks all `tool_use` parts in document order, builds a `tool_use_id → ToolResult` map and an Edit-coalescing decision (head/absorbed) map; the per-content-part renderer routes to Bash/Edit/Write reducers or falls back to the generic `<tool name=… …/>` for everything else. Coalescing is global-order: consecutive same-file Edits group regardless of which assistant message they live in; any intervening non-Edit tool or different-file Edit breaks the run.
- `render.test.ts`: 6 new integration tests through `renderClaudeSession` covering Bash result pairing, Write attrs, intra-turn coalescing, cross-turn coalescing, different-tool-breaks coalescing, different-file-breaks coalescing.
- `package.json` + `bun.lock`: `diff` 9.0.0 added.
- Created follow-up bean `dream-fkrw` for the operator-side token-ratio measurement; the same handoff path retroactively closes the deferred items in dream-jouq.

Code review (`pr-review-toolkit:code-reviewer`) found no critical or important issues. `bun check` green: 155 tests, 0 warnings, 0 errors.

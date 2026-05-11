---
# dream-9b9h
title: 'Per-tool reducers for high-volume tools: Bash, Edit, Write'
status: todo
type: feature
priority: high
created_at: 2026-05-11T13:33:58Z
updated_at: 2026-05-11T13:33:58Z
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

- [ ] `diff` and `@types/diff` added as dependencies; `bun pm view @types/diff` confirms DefinitelyTyped coverage before hand-rolling types.
- [ ] Bash reducer emits `cmd` + `exit` attrs and applies head 40 / tail 40 truncation past 200 lines or 8 KB; tail always preserved.
- [ ] Edit reducer emits `file` + `patches` attrs and a unified diff body; no fabricated `@@ line @@` numbers.
- [ ] Consecutive same-file Edit calls coalesce into one element with diffs back-to-back.
- [ ] Write reducer emits `file` + `lines` + `bytes` attrs; body verbatim ≤ 60 lines, head 30 + tail 10 past that.
- [ ] Fixture-driven tests covering: short Bash, long Bash (truncation triggered), Bash with non-zero exit + stderr tail preservation, single Edit, two consecutive same-file Edits coalescing, two non-consecutive same-file Edits *not* coalescing, Edit on a file that doesn't share context lines (diff is neutral vs separate blocks), Write under threshold, Write over threshold.
- [ ] `bun run ingest` against the m4x claude data produces rendered files that exercise all three reducers; `scripts/measure-tokens.sh` shows a tighter ratio than after slice dream-jouq.
- [ ] `bun check` passes.

## User stories addressed

- User story 14, 15, 16, 17


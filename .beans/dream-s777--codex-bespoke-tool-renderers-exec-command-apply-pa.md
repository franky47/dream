---
# dream-s777
title: 'Codex bespoke tool renderers: exec_command + apply_patch'
status: completed
type: feature
priority: normal
created_at: 2026-05-28T14:25:36Z
updated_at: 2026-05-28T17:30:00Z
parent: dream-gt5l
blocked_by:
    - dream-sohj
---

## What to build

Add bespoke renderers for the two Codex built-in tools that carry real semantic load in observed sessions: `exec_command` (shell) and `apply_patch` (file edits). Everything else (`write_stdin`, `update_plan`, all MCP) keeps flowing through the generic fallback from dream-sohj. After this slice, rendered Codex sessions read shell traces as proper shell blocks and file edits as diffs instead of XML-attribute projections of the raw input.

See parent PRD dream-gt5l "Codex-specific decisions" for the tool list rationale (observation-driven, not spec-driven) and the `exec_command` blob format.

## Acceptance criteria

- [x] `exec_command` registered in the Codex tool registry. Renders command + parsed output as a shell block. The `function_call_output.output` blob format (`Chunk ID: …`, `Wall time: …`, `Process exited with code: N`, `Original token count: …`, `Output:\n---\n…`) is parsed into command, exit code, and output sections; metadata (chunk id, wall time, token count) surfaced compactly.
- [x] `apply_patch` registered in the Codex tool registry (note: wrapped in `custom_tool_call`, not `function_call`). Renders the `*** Begin Patch … *** End Patch` script as a unified diff. Tool-result success/failure surfaced from the output envelope (`Exit code: N\n…`).
- [x] `write_stdin`, `update_plan`, and any `mcp__*` tool continue to route to the fallback unchanged.
- [x] Tests cover each bespoke renderer against a small fixture jsonl (real shape, redacted content), including: successful `exec_command`, failing `exec_command` (non-zero exit), successful `apply_patch` (add/modify/delete), failing `apply_patch`.
- [x] Existing end-to-end Codex renderer test updated (or a new one added) to verify the two bespoke renderers fire on a fixture session that uses both tools.
- [x] `bun check` clean.

## User stories addressed

- User story 6
- User story 7

## Summary of Changes

Added two bespoke renderers to `src/lib/codex/renderer/tools.ts`:

- `exec_command`: parses the `function_call_output.output` envelope to extract `exit`, `wall`, and the post-`Output:\n---\n` body. Surfaces compactly as `<tool name="exec_command" cmd="…" exit="N" wall="…s">body</tool>` (self-closing when the body is empty). `Chunk ID` and `Original token count` are intentionally elided. Falls back to a `cmd`-only self-closing tag when the envelope is missing or malformed, so a partial capture never crashes the render.
- `apply_patch`: parses the `*** Begin Patch … *** End Patch` script into per-file blocks (`Add File`, `Update File`, `Delete File`, with optional `Move to:` rename) and emits unified-diff headers (`--- a/…` / `+++ b/…`, with `/dev/null` for add/delete). The `@@` hunks, `+`/`-`/` ` body lines pass through verbatim. Tool-result success/failure surfaces from the `Exit code: N` envelope plus the upstream `isError` flag.

Both renderers wire into `codexTools`. The generic `codexFallback` is unchanged, so `write_stdin`, `update_plan`, and `mcp__*` tools continue to render as before. 20 new test cases in `tools.test.ts` plus one end-to-end fixture in `index.test.ts`.

---
# dream-s777
title: 'Codex bespoke tool renderers: exec_command + apply_patch'
status: todo
type: feature
created_at: 2026-05-28T14:25:36Z
updated_at: 2026-05-28T14:25:36Z
parent: dream-gt5l
blocked_by:
    - dream-sohj
---

## What to build

Add bespoke renderers for the two Codex built-in tools that carry real semantic load in observed sessions: `exec_command` (shell) and `apply_patch` (file edits). Everything else (`write_stdin`, `update_plan`, all MCP) keeps flowing through the generic fallback from dream-sohj. After this slice, rendered Codex sessions read shell traces as proper shell blocks and file edits as diffs instead of XML-attribute projections of the raw input.

See parent PRD dream-gt5l "Codex-specific decisions" for the tool list rationale (observation-driven, not spec-driven) and the `exec_command` blob format.

## Acceptance criteria

- [ ] `exec_command` registered in the Codex tool registry. Renders command + parsed output as a shell block. The `function_call_output.output` blob format (`Chunk ID: …`, `Wall time: …`, `Process exited with code: N`, `Original token count: …`, `Output:\n---\n…`) is parsed into command, exit code, and output sections; metadata (chunk id, wall time, token count) surfaced compactly.
- [ ] `apply_patch` registered in the Codex tool registry (note: wrapped in `custom_tool_call`, not `function_call`). Renders the `*** Begin Patch … *** End Patch` script as a unified diff. Tool-result success/failure surfaced from the output envelope (`Exit code: N\n…`).
- [ ] `write_stdin`, `update_plan`, and any `mcp__*` tool continue to route to the fallback unchanged.
- [ ] Tests cover each bespoke renderer against a small fixture jsonl (real shape, redacted content), including: successful `exec_command`, failing `exec_command` (non-zero exit), successful `apply_patch` (add/modify/delete), failing `apply_patch`.
- [ ] Existing end-to-end Codex renderer test updated (or a new one added) to verify the two bespoke renderers fire on a fixture session that uses both tools.
- [ ] `bun check` clean.

## User stories addressed

- User story 6
- User story 7

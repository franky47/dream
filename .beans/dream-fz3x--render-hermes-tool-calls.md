---
# dream-fz3x
title: Render Hermes tool calls
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:44:19Z
updated_at: 2026-07-20T09:44:19Z
parent: dream-sys9
blocked_by:
    - dream-gvmb
---

## What to build

Render Hermes tool calls with source-specific shapes that follow Dream's existing renderer conventions. Known tools should expose concise, useful inputs and results. Unknown tools must remain readable without blocking the session render.

## Acceptance criteria

- [x] Hermes tool-call and tool-result rows pair by call ID without changing message order.
- [x] Source-specific renderers cover terminal, file read, file write, patch, search, todo, and clarify shapes.
- [x] Terminal and patch output retain the useful command, result, status, and diff data supported by their Hermes result shapes.
- [x] Large write content is summarized with useful file statistics rather than copied into Markdown.
- [x] Unknown tools use the standard compact self-closing fallback with safe scalar attributes.
- [x] Failed known and unknown tools carry a concise error marker.
- [x] Tool arguments and results are validated with Zod before rendering.
- [x] Tests cover every supported shape, malformed optional results, call pairing, escaping, errors, and fallback behavior.
- [x] Any affected renderer documentation ships with the behavior.
- [x] The project-wide check command passes.

## User stories addressed

- User story 37
- User story 38

## Summary of Changes

- `src/lib/hermes/renderer/tools.ts` gains bespoke renderers for `terminal`,
  `read`, `write`, `patch`, `search`, `todo`, and `clarify`, keyed by tool
  name, alongside the existing compact self-closing fallback. Terminal and
  patch parse a Zod status envelope (`exitCode`, `status`) and keep their
  command/diff; write keeps `lines`/`bytes` statistics instead of the payload;
  every renderer marks failures with `error="1"` and escapes attributes.
- `src/lib/hermes/renderer/normalize.ts` pairs `tool_call` and `tool_result`
  message rows by call ID into one tool part on the assistant turn, preserving
  transcript order (mirrors the Codex renderer). A row that declares a tool
  envelope type but fails validation is dropped, never leaked as raw-JSON text.
- Tests: `tools.test.ts`, `normalize.test.ts`, and end-to-end additions in
  `index.test.ts`. README documents the tool-rendering behavior.

## Design Note

Hermes wraps OpenAI Codex, so tool calls follow the Codex/OpenAI response-item
format. The exact tool names and input/result field keys here were modeled on
that format plus Dream's renderer conventions: live SSH access to the Echo
Hermes database was unavailable in this worktree to confirm the exact strings.
The graceful fallback makes any name mismatch non-harmful (unknown tools render
compactly), and a malformed known-envelope row is skipped rather than leaked.
A follow-up should reconcile the tool names and field keys against real Echo
session data once SSH access is available.

## Reconciliation delta

Reconciled against live Echo tool captures. The verified tool names are
`terminal`, `skill_view`, `read_file`, `write_file`, `patch`, `search_files`,
`todo` and `clarify`; the earlier `read`/`write`/`search` names were modeled, not
real. A terminal result is `{output, exit_code, error}` (extra keys such as
`approval` may ride along), so failure is a non-zero `exit_code` or a non-null
`error` — the modeled `success:false` flag never appears on real rows and no
longer drives the error marker. A failed terminal run now surfaces its
`exit_code`. Verified result shapes drive the bespoke renderers: `read_file`
`{content}`, `write_file` `{bytes_written, resolved_path, ...}`, `patch` may be
`{error}`, `search_files` `{total_count, matches_text, ...}`, `todo` `{todos}`,
`clarify` `{question, choices_offered, ...}`. The fallback now sanitizes input
keys: only XML-safe names become attributes, a hostile key is escaped into the
body. When a tool-result row has null `content`, the projected `apiContent` is
read only if it parses to a JSON object, else the result keeps dropping.


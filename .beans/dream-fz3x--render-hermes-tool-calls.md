---
# dream-fz3x
title: Render Hermes tool calls
status: todo
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

- [ ] Hermes tool-call and tool-result rows pair by call ID without changing message order.
- [ ] Source-specific renderers cover terminal, file read, file write, patch, search, todo, and clarify shapes.
- [ ] Terminal and patch output retain the useful command, result, status, and diff data supported by their Hermes result shapes.
- [ ] Large write content is summarized with useful file statistics rather than copied into Markdown.
- [ ] Unknown tools use the standard compact self-closing fallback with safe scalar attributes.
- [ ] Failed known and unknown tools carry a concise error marker.
- [ ] Tool arguments and results are validated with Zod before rendering.
- [ ] Tests cover every supported shape, malformed optional results, call pairing, escaping, errors, and fallback behavior.
- [ ] Any affected renderer documentation ships with the behavior.
- [ ] The project-wide check command passes.

## User stories addressed

- User story 37
- User story 38


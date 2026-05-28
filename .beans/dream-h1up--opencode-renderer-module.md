---
# dream-h1up
title: OpenCode renderer module
status: todo
type: feature
priority: high
created_at: 2026-05-28T11:46:49Z
updated_at: 2026-05-28T11:46:49Z
parent: dream-sk72
blocked_by:
    - dream-alv5
---

## What to build

Build the OpenCode binding against the generic renderer core landed in `dream-alv5`. The slice ships a callable `renderOpencodeSession(jsonl): string` that takes an OpenCode projected-JSONL stream (as produced by `splitJsonlToSessionFiles`) and returns the rendered markdown. The module is not yet wired into ingest — that lands in `dream-ou0u`.

See parent PRD (`dream-sk72`) for the canonical `NormalizedSession` shape, the OpenCode-specific decisions (dropped part types, frontmatter fields, tool result coercion, status mapping), and the v1 tool-registry policy (fallback only, no per-tool specialisation).

Scope of this slice:

- New `src/lib/opencode/renderer/`:
  - `normalize.ts` — parses projected rows (`session` / `message` / `part`, interleaved), groups parts by `messageId`, walks messages in order, produces `NormalizedSession`. Keeps part types `text` and `tool`; drops `reasoning`, `step-start`, `step-finish`, `patch`, `file`, `agent`, `subtask`, `compaction`. Links tool I/O inline into `ToolPart.result` (call+result already co-located in source). Coerces non-string `state.output` via `JSON.stringify`. Status mapping: `completed` → `result.isError = false`; `error` → `result.isError = true`; otherwise `result` undefined.
  - `frontmatter.ts` — Zod schema + YAML serialiser for OpenCode frontmatter: `sessionId`, `cwd`, `project`, `startedAt`, `endedAt`, `turns`, `title`, `toolUses`, `providerID`, `modelID`, `agent`, `renderer='opencode-md@1'`.
  - `tools.ts` — exports `opencodeTools: Record<string, ToolRenderer<void>> = {}` and `opencodeFallback` rendering `<tool name="..." attrs/>` from the tool's `input`, with `error="1"` when `result.isError`.
  - `index.ts` — `renderOpencodeSession = jsonl => renderSession(normalize(jsonl), { preprocess: () => undefined as void, tools: opencodeTools, fallback: opencodeFallback })`.
- Co-located tests: `normalize.test.ts` (fixture rows in → expected `NormalizedSession` out, covering linkage, dropped parts, non-string output coercion, status-to-isError mapping); `frontmatter.test.ts` (fixture session row in → expected YAML out); `index.test.ts` (small end-to-end JSONL in → expected markdown out).

## Acceptance criteria

- [ ] `src/lib/opencode/renderer/` exists with `normalize.ts`, `frontmatter.ts`, `tools.ts`, `index.ts`, and co-located tests.
- [ ] `renderOpencodeSession(jsonl): string` is exported from `src/lib/opencode/renderer`.
- [ ] Normalizer drops `reasoning`, `step-start`, `step-finish`, `patch`, `file`, `agent`, `subtask`, `compaction` part types; keeps `text` and `tool`.
- [ ] Tool parts are emitted with linked `result` when source `state.status` is `completed` (isError false) or `error` (isError true); `result` is undefined otherwise.
- [ ] Non-string `state.output` is coerced via `JSON.stringify`.
- [ ] Frontmatter YAML contains all listed fields and uses the same escape rules as the Claude frontmatter serialiser.
- [ ] Fallback tool renderer produces `<tool name="..." attr="..."/>` projecting string/number/boolean keys from `input`, with `error="1"` on error result.
- [ ] `bun check` clean.
- [ ] No imports from `src/ingest/`. Imports `src/lib/renderer/` for shared types and driver.

## User stories addressed

Reference by number from the parent PRD (`dream-sk72`):

- User story 6
- User story 7
- User story 11
- User story 14
- User story 15
- User story 16

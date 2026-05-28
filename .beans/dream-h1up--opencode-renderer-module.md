---
# dream-h1up
title: OpenCode renderer module
status: completed
type: feature
priority: high
created_at: 2026-05-28T11:46:49Z
updated_at: 2026-05-28T12:25:34Z
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

- [x] `src/lib/opencode/renderer/` exists with `normalize.ts`, `frontmatter.ts`, `tools.ts`, `index.ts`, and co-located tests.
- [x] `renderOpencodeSession(jsonl): string` is exported from `src/lib/opencode/renderer`.
- [x] Normalizer drops `reasoning`, `step-start`, `step-finish`, `patch`, `file`, `agent`, `subtask`, `compaction` part types; keeps `text` and `tool`.
- [x] Tool parts are emitted with linked `result` when source `state.status` is `completed` (isError false) or `error` (isError true); `result` is undefined otherwise.
- [x] Non-string `state.output` is coerced via `JSON.stringify`.
- [x] Frontmatter YAML contains all listed fields and uses the same escape rules as the Claude frontmatter serialiser.
- [x] Fallback tool renderer produces `<tool name="..." attr="..."/>` projecting string/number/boolean keys from `input`, with `error="1"` on error result.
- [x] `bun check` clean.
- [x] No imports from `src/ingest/`. Imports `src/lib/renderer/` for shared types and driver.

## User stories addressed

Reference by number from the parent PRD (`dream-sk72`):

- User story 6
- User story 7
- User story 11
- User story 14
- User story 15
- User story 16

## Summary of Changes

New OpenCode renderer binding at `src/lib/opencode/renderer/`, built against the generic core from `dream-alv5`:

- `frontmatter.ts` — Zod-typed `Frontmatter` (sessionId, cwd, project, startedAt, endedAt, turns, title, toolUses, providerID, modelID, agent, renderer='opencode-md@1'). `extractFrontmatter(jsonl)` walks rows once: session header for sessionId/cwd/title/project (basename(worktree) fallback when project.name is null), messages for turns + start/end stamps (ISO from ms), parts for toolUses, first assistant message for providerID/modelID, first agent-bearing message for agent. `frontmatterToYaml` mirrors Claude's escape rules (quote strings, escape `\` and `"`).
- `normalize.ts` — three Zod schemas (message, text part, tool part) consume rows via `safeParse`; anything else (reasoning/step-start/step-finish/patch/file/agent/subtask/compaction or unparseable) is dropped silently. Parts are accumulated into a `Map<messageId, Part[]>`, then attached when walking messages in arrival order, so out-of-order parts still group correctly. Tool result mapping: `completed` → `{ content, isError: false }`; `error` → `{ content: state.output ?? state.error ?? '', isError: true }`; otherwise undefined. Non-string `state.output` is `JSON.stringify`'d.
- `tools.ts` — `opencodeTools = {}` (registry empty in v1) + `opencodeFallback` emitting `<tool name="..." k="v"/>`. Projects only string/number/boolean input keys; XML-escapes `& < > " \n \r \t` in string values; appends `error="1"` when `result.isError`.
- `index.ts` — `renderOpencodeSession(jsonl)` is `renderSession(normalize(jsonl), { preprocess: () => undefined as void, tools, fallback })`.

Co-located tests (26 cases across `frontmatter.test.ts`, `tools.test.ts`, `normalize.test.ts`, `index.test.ts`) cover schema parsing, the dropped-part-type set, status→isError mapping, output coercion, fallback attribute projection + XML escaping, and an end-to-end render. Verified against a real session (`data/m4x/opencode/ses_1e57d3ee6ffe3pIJFcLvglAZe2.jsonl`, 275 rows) — frontmatter and turn-marker stream render as expected. `bun check` clean (246 tests, 0 lint/type/knip warnings). Ingest wiring lives in `dream-ou0u`; this slice ships the module only.

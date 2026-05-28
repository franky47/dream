---
# dream-alv5
title: Generic renderer core + Claude rebound (byte-identical)
status: completed
type: feature
priority: high
created_at: 2026-05-28T11:46:46Z
updated_at: 2026-05-28T12:01:08Z
parent: dream-sk72
---

## What to build

Extract the generic concerns from the Claude renderer into a new agent-agnostic core, and reshape the existing Claude renderer as the first binding against it. Public Claude API (`renderClaudeSession(jsonl): string`) keeps its signature so `local-claude.ts` and `ssh-claude.ts` are not modified. End-to-end demoable behaviour: running the refactored code over any real Claude session produces a `.md` file byte-identical to what the pre-refactor code produced.

See parent PRD (`dream-sk72`) for the canonical `NormalizedSession` shape, the `RenderConfig<S>` interface, the architectural rules around tool-call linkage at normalize time, and the byte-identical verification gate.

Scope of this slice:

- New `src/lib/renderer/` core: `types.ts` (`NormalizedSession`, `NormalizedMessage`, `Part`, `ToolPart`, `RenderConfig<S>`, `RenderCtx<S>`, `ToolRenderer<S>`) and `render.ts` (`renderSession<S>` driver with turn-marker emission, timestamp delta formatting, registry-based tool dispatch with fallback, empty-string-means-skip semantics).
- Co-located generic-core tests exercising the driver with synthetic `NormalizedSession` fixtures (no Claude knowledge).
- Refactor `src/lib/claude/renderer/`: add `normalize.ts` (lifts content parts, links `tool_result` parts into matching `ToolPart.result`, applies `stripFraming` to user text, drops `thinking` parts and Claude's dropped entry types, preserves bare-marker empty messages); add `preprocess.ts` exposing `ClaudeState` and the Edit-fold preprocess; refactor `tools.ts` to export `claudeTools` registry + `claudeFallback` with adapted signatures (per-tool helpers preserved); extract `stripFraming` into `framing.ts`; rewrite `index.ts` as the thin wrapper; delete the old `render.ts` driver.
- Existing Claude tests (`render.test.ts`, `tools.test.ts`, `frontmatter.test.ts`) keep targeting `renderClaudeSession` and must keep passing — mechanical import-path tweaks only.

## Acceptance criteria

- [x] `src/lib/renderer/` exists with `types.ts`, `render.ts`, and `render.test.ts`. No agent-specific imports or knowledge.
- [x] Generic-core tests cover: turn marker emission, `t="0"` first-stamp logic, monotonic delta formatting, messages with missing timestamps, empty-body messages emit bare turn marker, tool dispatch via registry, fallback for unknown tool name, state seeded by preprocess and mutated across tool calls.
- [x] `src/lib/claude/renderer/` has `normalize.ts`, `preprocess.ts`, `tools.ts` (registry shape), `framing.ts`, `frontmatter.ts`, `entries.ts`, `index.ts`. The old monolithic `render.ts` driver is deleted.
- [x] `renderClaudeSession(jsonl): string` keeps its export name and signature. `src/ingest/sources/local-claude.ts` and `src/ingest/sources/ssh-claude.ts` are not modified.
- [x] Existing Claude renderer tests pass without behavioural changes (mechanical import-path tweaks allowed).
- [x] Byte-identical verification: pick at least one real session under `~/.claude/projects/-Users-franky-dev-playground-ai-dream/`, render with pre-refactor code and post-refactor code, `diff` is empty.
- [x] `bun check` clean.
- [x] `src/lib/` does not import `src/ingest/`. Per-agent bindings import from `src/lib/renderer/`, not the other way around.

## User stories addressed

Reference by number from the parent PRD (`dream-sk72`):

- User story 1
- User story 2
- User story 3
- User story 4
- User story 8
- User story 9
- User story 10
- User story 17
- User story 18

## Summary of Changes

Generic renderer core lives at `src/lib/renderer/`:

- `types.ts` — `NormalizedSession`, `NormalizedMessage`, `Part` (text/tool union), `ToolPart`, `ToolResult`, `RenderConfig<S>`, `RenderCtx<S>`, `ToolRenderer<S>`. `TextPart` is internal (consumed via `Extract<Part, { kind: 'text' }>`).
- `render.ts` — `renderSession<S>(session, config)`: emits frontmatter, walks messages, emits turn markers with `t="0"` first-stamp + `+MMmSSs` deltas, dispatches tool parts via registry with fallback, skips empty-string renderer output (the Edit-absorbed quirk).
- `render.test.ts` — synthetic `NormalizedSession` fixtures cover all required behaviors with zero Claude knowledge.

Claude binding reshaped at `src/lib/claude/renderer/`:

- `framing.ts` — `stripFraming` extracted (was in `entries.ts`).
- `normalize.ts` — `normalize(jsonl) → NormalizedSession`: parses entries, builds tool_result map, lifts/links results into assistant `ToolPart.result`, applies `stripFraming` to user text, drops `thinking` parts and `DROPPED_ENTRY_TYPES`, preserves bare-marker user entries.
- `preprocess.ts` — `ClaudeState` (`editStats`, `editAbsorbed`, mutable `lastTodos`) + `claudePreprocess` runs Edit-fold over linked tool parts.
- `tools.ts` — per-tool helpers retained (existing tests target them). New `claudeTools` registry + `claudeFallback` adapt them to `ToolRenderer<ClaudeState>`.
- `index.ts` — thin wrapper: `renderClaudeSession(jsonl) = renderSession(normalize(jsonl), { preprocess, tools, fallback })`. Old monolithic `render.ts` deleted.

Byte-identical verification: rendered all 31 real sessions under `~/.claude/projects/-Users-franky-dev-playground-ai-dream/` before and after — `diff -r` empty (only the in-flight session file differs because it grows as work happens).

`local-claude.ts` / `ssh-claude.ts` untouched. `bun check` clean (220 tests, 0 lint/type/knip warnings).

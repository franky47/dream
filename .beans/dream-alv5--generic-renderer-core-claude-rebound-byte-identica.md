---
# dream-alv5
title: Generic renderer core + Claude rebound (byte-identical)
status: todo
type: feature
priority: high
created_at: 2026-05-28T11:46:46Z
updated_at: 2026-05-28T11:46:46Z
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

- [ ] `src/lib/renderer/` exists with `types.ts`, `render.ts`, and `render.test.ts`. No agent-specific imports or knowledge.
- [ ] Generic-core tests cover: turn marker emission, `t="0"` first-stamp logic, monotonic delta formatting, messages with missing timestamps, empty-body messages emit bare turn marker, tool dispatch via registry, fallback for unknown tool name, state seeded by preprocess and mutated across tool calls.
- [ ] `src/lib/claude/renderer/` has `normalize.ts`, `preprocess.ts`, `tools.ts` (registry shape), `framing.ts`, `frontmatter.ts`, `entries.ts`, `index.ts`. The old monolithic `render.ts` driver is deleted.
- [ ] `renderClaudeSession(jsonl): string` keeps its export name and signature. `src/ingest/sources/local-claude.ts` and `src/ingest/sources/ssh-claude.ts` are not modified.
- [ ] Existing Claude renderer tests pass without behavioural changes (mechanical import-path tweaks allowed).
- [ ] Byte-identical verification: pick at least one real session under `~/.claude/projects/-Users-franky-dev-playground-ai-dream/`, render with pre-refactor code and post-refactor code, `diff` is empty.
- [ ] `bun check` clean.
- [ ] `src/lib/` does not import `src/ingest/`. Per-agent bindings import from `src/lib/renderer/`, not the other way around.

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

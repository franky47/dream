---
# dream-sk72
title: Refactor session renderer to generic core with Claude + OpenCode bindings
status: todo
type: epic
created_at: 2026-05-28T11:43:53Z
updated_at: 2026-05-28T11:43:53Z
---

## Problem Statement

Today the session renderer lives at `src/lib/claude/renderer/` and is hard-wired to Claude Code's JSONL shape. It parses Claude entries, lifts content parts, links `tool_use`/`tool_result` by id at render time, applies Claude-specific framing strips, runs Claude-specific Edit-fold preprocessing, dispatches to Claude tool renderers via an inline switch, and emits a Claude-specific YAML frontmatter. Every concern — generic (turn markers, timestamp deltas, body composition) and agent-specific (Edit folding, TodoWrite cross-call state, `stripFraming`, tool registry, frontmatter schema) — is interleaved in one driver.

OpenCode sessions are already ingested into the data lake but produce only raw `.jsonl` files — no `.md` sibling. The downstream readers (humans, future indexers) expect markdown alongside JSONL for every agent. Codex and Pi will land as new sources soon, with their own JSONL shapes (Codex flattens function_call/function_call_output as top-level entries; Pi is a branching tree linked by id/parentId). Bolting each new agent onto the Claude renderer by copy-paste-and-mutate would duplicate the generic concerns four times and almost guarantee drift.

We need a generic session renderer that takes per-agent normalizers, tool registries, and frontmatter, and produces uniform markdown output across Claude, OpenCode, and future agents — without changing what the Claude renderer emits today, byte for byte.

## Solution

Extract the generic concerns into a `src/lib/renderer/` core that operates on a single canonical `NormalizedSession` shape, and reshape Claude as the first binding against it. Validate the abstraction in the same PR by writing a second binding for OpenCode, which currently has no renderer at all — proving the API can serve at least two materially different session shapes before any further sources land.

The canonical shape is `{frontmatterYaml: string, messages: NormalizedMessage[]}`, where each message carries `role`, `timestampMs`, and `parts[]` of either `text` or `tool` kind. Tool parts carry the linked call+result inline (`{id, name, input, result?}`) — linkage happens at normalize time, not render time, because OpenCode/Pi/Codex all link their tool I/O at the source and Claude's scattered shape is the outlier. This collapses the renderer's per-call `results.get(id)` threading into a flat walk.

The generic driver iterates messages, emits turn markers with deltas from the first stamp, and dispatches each tool part through a per-agent `Record<name, ToolRenderer<S>> + fallback`, where `S` is a typed per-agent state bag produced by a preprocess hook and threaded through tool renderers. Claude's state holds the Edit-fold tables plus the `lastTodos` diff anchor; OpenCode's state is `void` in v1.

Frontmatter stays per-agent: each binding owns its own schema and YAML serialiser, surfaced to the core as an already-rendered string on `NormalizedSession`. No shared `FrontmatterFields` interface — the field sets diverge too sharply across agents to be worth unifying, and per-agent YAML matches the existing project preference for simplest-per-case implementations.

The Claude binding becomes a thin wrapper that calls `normalize(jsonl)` then `renderSession(session, claudeConfig)`. Its public export (`renderClaudeSession`) keeps the same signature so neither `local-claude` nor `ssh-claude` ingest sources change. The OpenCode binding follows the same pattern with a fallback-only tool registry in v1 (no per-tool specialisation yet) and gets wired into `local-opencode` / `ssh-opencode` via a post-pass that reads each just-written `.jsonl` and writes a `.md` sibling — mirroring how Claude already does it.

Byte-identical Claude output before vs after the refactor is the verification gate. Until a diff against a real session is empty, the refactor doesn't merge.

## User Stories

1. As a developer extending the data lake with a new agent source, I want a generic session renderer that takes a normalizer + tool registry + frontmatter, so that I can add a new agent without forking the rendering pipeline.
2. As a developer maintaining the Claude renderer, I want generic concerns (turn markers, timestamp deltas, body composition, tool dispatch) lifted into a shared core, so that bug fixes in those areas land once and benefit every agent.
3. As a developer maintaining the Claude renderer, I want Claude-specific concerns (`stripFraming`, Edit fold, TodoWrite diff state) to remain in the Claude binding, so that they can be reasoned about, tested, and changed without touching the generic core.
4. As a downstream reader of session markdown, I want byte-identical output for Claude sessions before and after the refactor, so that no regressions land silently.
5. As a downstream reader of OpenCode sessions, I want a `.md` sibling alongside every `.jsonl` in the data lake, so that OpenCode sessions are browsable the same way Claude sessions are.
6. As a developer building a Pi source later, I want the `NormalizedSession` shape to accept tool-call/tool-result linkage as native, so that I can write a normalizer that walks the active branch and yields linked tool parts without reshaping the renderer.
7. As a developer building a Codex source later, I want top-level `function_call`/`function_call_output` entries to pair into a single normalized tool part by `call_id`, so that the renderer doesn't care that Codex scatters them at the top level.
8. As a tool renderer author, I want a registry-based dispatch so I can add or override a tool renderer by name without touching the driver.
9. As a tool renderer author, I want a typed per-agent state bag threaded through every tool call, so that cross-call state (TodoWrite diff anchor, Edit-fold absorption sets) is type-safe and not stringly-keyed.
10. As a tool renderer author, I want returning an empty string to mean "skip this tool", so that the Edit-fold tail-absorption quirk and other "render nothing here" cases are expressible without a special signal.
11. As a developer reading session markdown, I want frontmatter that captures the fields meaningful to each agent (Claude's `aiTitle`, OpenCode's `providerID`/`modelID`/`agent`, Codex's `originator`/`cliVersion`/`git`), so that I'm not forced into a lowest-common-denominator schema.
12. As an ingest source author, I want OpenCode rendering wired in via the same pattern Claude uses (read the just-written `.jsonl`, write `.md` sibling), so that the ingest pipeline stays uniform and the splitter stays single-purpose.
13. As a developer reviewing the refactor PR, I want OpenCode rendering exercised in the same PR as the abstraction, so that the API has a second real consumer before it's declared stable.
14. As a tool renderer author writing OpenCode bindings, I want a generic fallback renderer that projects a tool's input as XML attributes, so that v1 OpenCode renders all tools sensibly without per-tool work.
15. As a developer reading OpenCode rendered output, I don't want `reasoning`, `step-start`, `step-finish`, `patch`, `file`, `agent`, `subtask`, `compaction` parts to clutter the markdown, so that the conversation reads cleanly. (These may be re-enabled later if useful.)
16. As a developer reading any session, I don't want `thinking` / `reasoning` content rendered, since the raw JSONL preserves it for anyone who needs it.
17. As a developer running `bun check`, I want the typecheck + co-located tests to be the only verification path, so that the project's "no bespoke commands" convention holds.
18. As a developer running `bun check`, I want the existing Claude renderer tests to continue passing without modification (or with only mechanical import-path tweaks), so that the test suite remains the safety net against rendering drift.

## Implementation Decisions

**Modules created**

- A new generic core at `src/lib/renderer/`. Owns the `NormalizedSession` / `NormalizedMessage` / `Part` / `ToolPart` types, the `RenderConfig<S>` interface, and the `renderSession<S>` driver (turn-marker emission, timestamp-delta computation, body composition, registry-based tool dispatch with fallback).
- A new OpenCode renderer binding at `src/lib/opencode/renderer/`. Owns the OpenCode normalizer (projected SQLite JSONL → `NormalizedSession`), the OpenCode frontmatter schema + YAML serialiser, and the OpenCode tool registry (empty in v1) + fallback.

**Modules modified**

- The Claude renderer at `src/lib/claude/renderer/`. Reshaped from a monolithic `render.ts` driver into: a `normalize.ts` that produces `NormalizedSession` (lifting content parts, linking tool results into tool parts, applying `stripFraming` to user text, dropping `thinking` parts and Claude's dropped entry types); a `preprocess.ts` exposing `ClaudeState` and the Edit-fold preprocess; a `tools.ts` exposing a registry keyed by tool name plus a fallback (per-tool helpers preserved, their signatures adapted to `(tool, ctx) => string`); a thin `index.ts` wrapping `normalize` + `renderSession`. The public export `renderClaudeSession(jsonl)` keeps its signature. `stripFraming` extracted to its own file.
- The OpenCode splitter at `src/lib/opencode/pull/splitter.ts`. Extended to return written session file paths in its metrics, so the post-pass renderer can iterate them.
- The OpenCode ingest sources `src/ingest/sources/local-opencode.ts` and `src/ingest/sources/ssh-opencode.ts`. After `splitJsonlToSessionFiles`, iterate the written `.jsonl` paths, read each, call `renderOpencodeSession`, write the `.md` sibling. Mirrors Claude's pattern.

**Canonical interfaces**

- `NormalizedSession = { frontmatterYaml: string, messages: NormalizedMessage[] }`. Frontmatter is pre-rendered; the core never inspects its contents.
- `NormalizedMessage = { role: 'user' | 'assistant', timestampMs: number | null, parts: Part[] }`. Empty `parts[]` is valid and still emits a turn marker (preserves Claude's bare-marker quirk for tool-result-only entries).
- `Part = TextPart | ToolPart` where `TextPart = { kind: 'text', text }` and `ToolPart = { kind: 'tool', id, name, input, result? }` with `result = { content: string, isError: boolean }`.
- `RenderConfig<S> = { preprocess: (msgs) => S, tools: Record<string, ToolRenderer<S>>, fallback: ToolRenderer<S> }`.
- `ToolRenderer<S> = (tool: ToolPart, ctx: { state: S }) => string`. Empty string means "skip this part".

**Architectural rules**

- Tool-call/tool-result linkage happens in the normalizer, not the renderer. The renderer never threads a results map.
- Dropped types and content kinds are normalizer concerns. The core has no awareness of which types are dropped.
- Framing strips, Edit folding, TodoWrite diff anchoring are Claude-specific and live in the Claude binding. The core has no Claude knowledge.
- Tool names are not normalised across agents. Claude's `Edit` and OpenCode's `edit` are distinct keys in distinct registries.
- Per-agent state type is a generic parameter on `RenderConfig`, `ToolRenderer`, `RenderCtx`. State is mutable. Claude state holds `{ editAbsorbed: Set<string>, editStats: Map<string, EditStats>, lastTodos: TodoItem[] | null }`. OpenCode state is `void` in v1.
- `src/lib/{claude,opencode}/renderer/` imports `src/lib/renderer/`; not the other way around. No `src/lib/` → `src/ingest/` imports introduced.

**OpenCode-specific decisions**

- Tool registry in v1 is empty; everything routes to the fallback, which renders `<tool name="..." attrs/>` from `state.input`. Per-tool specialisation is deferred.
- Part types `text` and `tool` are normalised. `reasoning`, `step-start`, `step-finish`, `patch`, `file`, `agent`, `subtask`, `compaction` are dropped in v1; reversible if real sessions demand them.
- Frontmatter fields: `sessionId`, `cwd`, `project`, `startedAt`, `endedAt`, `turns`, `title`, `toolUses`, `providerID`, `modelID`, `agent`, `renderer='opencode-md@1'`. Similar shape to Claude's frontmatter for downstream uniformity, plus OpenCode-specific extras.
- Tool result `state.output` may be non-string for non-bash tools. Normalizer coerces non-strings via `JSON.stringify` (or skips the result if not coercible) to keep `ToolPart.result.content` typed as string.
- Status mapping: `state.status === 'completed'` → `result.isError = false`; `state.status === 'error'` → `result.isError = true`; running/missing → `result` undefined.

**Verification gate**

- `bun check` clean is necessary but not sufficient. The PR also requires a byte-identical `.md` diff for at least one real Claude session under `~/.claude/projects/-Users-franky-dev-playground-ai-dream/`, rendered against the pre-refactor and post-refactor code. The OpenCode binding is verified by `bun check` plus eyeballing a real OpenCode session's `.md` output.

## Testing Decisions

**What makes a good test here**

External behaviour only. Each layer is tested at its public seam:

- The generic core is tested by feeding synthetic `NormalizedSession` fixtures into `renderSession` and asserting on the output string. The fixtures don't pretend to be Claude or OpenCode — they exercise turn markers, timestamp deltas (including `t="0"` first stamp, missing timestamps, monotonic deltas), empty bodies producing bare markers, tool dispatch through the registry, fallback for unknown tool names, and state mutation across tool calls (a TodoWrite-style anchor) and state seeding via preprocess.
- The Claude binding's existing tests (`render.test.ts`, `tools.test.ts`, `frontmatter.test.ts`) keep targeting `renderClaudeSession(jsonl)` and must keep passing — they are the regression net for byte-identical output. No structural rewrites; only mechanical import-path tweaks if any test reaches into renamed internals.
- The OpenCode binding gets co-located tests covering the normalizer (a projected-row fixture in, expected `NormalizedSession` out, including tool linkage and dropped-part filtering), the frontmatter serialiser (fixture session row in, expected YAML out), and the end-to-end `renderOpencodeSession(jsonl)` against a small fixture session.
- The OpenCode splitter gets a small test addition verifying the new `sessionPaths` field in the returned metrics points at the right files.

**Modules to test**

- `src/lib/renderer/render.test.ts` — the generic driver.
- `src/lib/claude/renderer/*.test.ts` — existing tests retained as the byte-identical regression net.
- `src/lib/opencode/renderer/normalize.test.ts`, `frontmatter.test.ts`, and an end-to-end test for `renderOpencodeSession`.
- `src/lib/opencode/pull/splitter.test.ts` — updated for `sessionPaths` in returned metrics.

**Prior art**

- The existing `src/lib/claude/renderer/render.test.ts`, `tools.test.ts`, `frontmatter.test.ts` already follow the pattern of feeding a JSONL string into the public function and asserting on the markdown output. The new tests mirror this style.
- The existing `src/lib/opencode/pull/projection.test.ts` and `splitter.test.ts` cover the OpenCode pull pipeline in the same fixture-in / observable-out style.

## Out of Scope

- Codex and Pi normalizers. Land in follow-up PRs against this same `NormalizedSession` shape.
- Per-tool specialised renderers for OpenCode (bash, edit, write, read, glob, etc.). v1 ships fallback only.
- Tool-name normalisation across agents (Claude `Edit` vs OpenCode `edit`).
- A unified cross-agent frontmatter schema. Each agent owns its own shape.
- Handling of OpenCode `patch`, `file`, `agent`, `subtask`, `compaction` part types. Dropped in v1; revisit when real sessions need them.
- New render features for either agent (different markup, alternative output formats, summarisation). Pure shape refactor only.

## Further Notes

- Linkage of tool calls and tool results moves out of the renderer into each agent's normalizer. This deliberately makes Claude's normalizer carry the burden of reshaping scattered tool I/O into the linked shape that OpenCode/Pi/Codex hand over natively — the cost lands once, in the outlier.
- The byte-identical Claude verification is the load-bearing assertion. If a real-session diff is non-empty, the refactor is wrong; debug normalize/preprocess/tools until the diff is empty. Don't ship a "small intentional difference" — there are none.
- Dropping OpenCode `step-start`/`step-finish` parts in v1 also drops their `snapshot` hashes from the rendered output. Those hashes could be useful later for patch reconstruction. Flag this in the commit message; reversal is a normalizer change only.
- The plan-of-attack and a more detailed walkthrough of every design-tree branch are captured in `PLAN-renderer-refactor.md` at the repo root.

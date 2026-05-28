---
# dream-gt5l
title: Local Codex & Pi sources with .md session renderers
status: todo
type: epic
created_at: 2026-05-28T14:21:28Z
updated_at: 2026-05-28T14:21:28Z
---

## Problem Statement

The data lake currently ingests Claude Code sessions (local + ssh), OpenCode sessions (local + ssh), and Firefox snapshots. Two other coding agents the user runs daily — OpenAI's Codex CLI (`~/.codex/sessions/`) and Pi (`~/.pi/agent/sessions/`) — are absent. Their jsonl session logs sit on disk untouched, so cross-agent search, browsing, and downstream indexing skip everything done in those tools. The user has no `.md` rendering for either, which is the surface every other source already publishes alongside the raw jsonl.

Codex and Pi have meaningfully different session shapes from Claude and OpenCode:
- Codex pairs top-level `function_call` / `function_call_output` records by `call_id`, plus a `custom_tool_call` flavor for `apply_patch`. Sessions live in a flat `YYYY/MM/DD/rollout-*.jsonl` tree with no project segment in the path. Codex also writes user-facing markdown memories at `~/.codex/memories/**/*.md` (global, not per-project; managed by Codex itself).
- Pi sessions are **trees**, not linear conversations: every entry carries `id` + `parentId`, branches exist, and `compaction` entries replace pre-`firstKeptEntryId` history with a `summary`. The session-format spec deliberately leaves `toolCall.arguments` and `toolResult.details` as opaque maps — schemas are de-facto, not contractual. Pi sessions are organized per-project in `--<slug>--/` subdirs. Pi has no user-memory concept.

Without bespoke sources and renderers, the existing generic core (`src/lib/renderer/`, landed in dream-sk72) is ready to serve both agents but has no bindings for them.

## Solution

Two new ingest sources (`local-codex`, `local-pi`) and two new renderer bindings (`src/lib/codex/renderer/`, `src/lib/pi/renderer/`), built against the existing generic core. Both sources follow the file-based mtime-day-bucket pattern already proven by `local-claude` (Glob source dir, copy in-window jsonl into `<day>/<machine>/<source>/...`, render `.md` sibling per jsonl). Both renderers compose `normalize → renderSession` against the canonical `NormalizedSession` shape; per-agent normalizers reshape each agent's quirks into linked tool parts and a pre-rendered frontmatter string.

Codex layout in the data lake flattens the source date tree (the destination day-bucket already encodes the date — preserving `YYYY/MM/DD/` underneath would be redundant). The codex source also globs `~/.codex/memories/**/*.md` recursively and copies under `<day>/<machine>/codex/memories/<rel>` keyed by file mtime, mirroring the role Claude's per-project `memory/*.md` plays. Codex memories are global (no project segment), and the corpus today is empty — the glob still ships for forward-compatibility.

Pi layout preserves the source `--<slug>--/` project subdir verbatim (analogous to Claude's per-project layout). The Pi renderer walks leaf → root from the current branch, reverses, and substitutes any on-path `compaction.summary` for pre-`firstKeptEntryId` history. Branches off the active path are not rendered in v1. The 4 actually-used built-in tools (`bash`, `read`, `edit`, `write`) get bespoke renderers; everything else (extension tools, custom messages, future built-ins) flows through the generic fallback.

Codex's bespoke renderers cover the two tools that carry real semantic load in observed sessions: `exec_command` (the shell tool — parse its blob output format) and `apply_patch` (treat the patch script as a diff). All other Codex tools (`write_stdin`, `update_plan`, all MCP namespaces) route to the fallback. The MCP dual-channel quirk (`function_call_output` string vs paired `event_msg.mcp_tool_call_end` structured record) is reconciled at normalize time by preferring the structured record when present.

Wiring follows the existing pattern: both sources land unconditionally in `src/ingest/main.ts` (parallel to `ingestLocalClaude`/`ingestLocalOpencode`), default to `~/.codex` and `~/.pi/agent` respectively, and return zero metrics gracefully when the source root doesn't exist (per the project's established missing-optional-file convention).

## User Stories

1. As a user running both Codex and Pi locally, I want their session jsonl files copied into the data lake's day buckets, so that they live alongside Claude and OpenCode sessions and feed the same downstream consumers.
2. As a user browsing the data lake, I want a `.md` sibling for every Codex jsonl, so that I can read what Codex did without having to parse raw JSONL.
3. As a user browsing the data lake, I want a `.md` sibling for every Pi jsonl, so that I can read what Pi did without having to walk the branching tree by hand.
4. As a user running Codex who relies on its memory system, I want my `~/.codex/memories/**/*.md` files pulled into the data lake by mtime, so that the memory state at any given day is recoverable from the lake.
5. As a user with no Codex memories yet, I want the memory glob to ship anyway so that the moment Codex starts writing memories they're captured — no follow-up wiring needed.
6. As a user reading a rendered Codex session, I want `exec_command` calls rendered as readable shell blocks (command + parsed output), so that long shell traces are scannable.
7. As a user reading a rendered Codex session, I want `apply_patch` calls rendered as diffs, so that file edits are easy to review.
8. As a user reading a rendered Codex session, I want unknown tools (`write_stdin`, `update_plan`, MCP tools) to render through a generic fallback rather than being dropped, so that nothing the model did goes invisible.
9. As a user reading a rendered Codex session, I want MCP tool results that exist in both the string and structured channels to render once (the structured one), so that the output isn't duplicated.
10. As a user reading a rendered Codex session, I don't want `token_count` noise, `event_msg.agent_message` chunks that duplicate the final `response_item.message`, or empty `reasoning` entries (`summary:[]`, `content:null`) cluttering the markdown.
11. As a user reading a rendered Pi session, I want the `.md` to show the current branch (leaf → root, reversed), so that it matches what the TUI would show "now."
12. As a user reading a rendered Pi session with a compaction event on the active branch, I want pre-compaction history collapsed into the compaction summary, so that the rendered transcript matches the model's actual context.
13. As a user reading a rendered Pi session, I want `bash`, `read`, `edit`, and `write` rendered with shape-aware formatting (e.g. `edit` using `details.diff`), so that the four tools that carry the conversation read cleanly.
14. As a user reading a rendered Pi session, I want extension `custom_message` entries (e.g. scheduler-task, pi-splash) to render through a generic fallback rather than being dropped, so that extension activity is still visible.
15. As a user reading a rendered Pi session, I want `bashExecution` role entries (the `!cmd` editor escape) rendered distinctly from LLM-issued `bash` tool calls, so that user shell escapes aren't confused with assistant tool output.
16. As a user reading a rendered Pi session, I want `excludeFromContext:true` entries flagged in the markdown, so that I can tell what the LLM actually saw vs what was display-only.
17. As a user with no Pi or Codex installation, I want the ingest run to succeed with zero metrics for the missing source rather than failing the whole run, so that the same `ingest` invocation works across machines with different agent installations.
18. As a developer reading the source list, I want `local-codex` and `local-pi` to follow the established `local-<source>` naming convention and `{machine, sourceDir}` opt shape, so that the source list stays uniform.
19. As a developer running `bun check`, I want all new code typechecked, linted, formatted, tested, and free of unused exports, with no bespoke commands invoked, so that the project's "one check command" rule holds.
20. As a developer evolving the generic renderer core, I want each new binding to be a pure consumer of the existing `RenderConfig<S>` API (no core changes), so that the abstraction is validated against four agents (Claude, OpenCode, Codex, Pi) without regressions.
21. As a developer extending Codex tool rendering later, I want bespoke renderers gated on observed usage rather than written speculatively from spec, so that the codebase doesn't accumulate untested code paths for tools that may never appear locally.
22. As a developer extending Pi rendering later, I want the leaf-walk and compaction-substitution logic kept in a small testable helper, so that the eventual "show full history" mode can opt into a different walk without re-implementing tree resolution.
23. As a developer adding ssh variants later (`ssh-codex`, `ssh-pi`), I want the local sources structured so the file-copy and rendering logic are reusable, so that the ssh variant only adds the transport layer.
24. As a downstream indexer of the data lake, I want every Codex and Pi session's frontmatter to carry the agent-meaningful fields (Codex: id, cwd, model_provider, cli_version, git; Pi: id, cwd, version, parentSession, latest model/thinking-level/session-name, accumulated usage), so that filtering and grouping work the same way they do for Claude and OpenCode.

## Implementation Decisions

**Modules created**

- A new ingest source for local Codex sessions. Globs `~/.codex/sessions/**/*.jsonl`, copies in-window files (by mtime) into a flat `<day>/<machine>/codex/<filename>.jsonl` layout, also globs `~/.codex/memories/**/*.md` into `<day>/<machine>/codex/memories/<rel>` preserving the source subtree, renders `.md` sibling per session jsonl. Returns metrics `{sessions_pulled, memories_pulled, bytes}`. Early-returns zero metrics if the source root doesn't exist.
- A new ingest source for local Pi sessions. Globs `~/.pi/agent/sessions/**/*.jsonl`, copies in-window files (by mtime) into `<day>/<machine>/pi/<project-slug>/<filename>.jsonl` preserving the source's `--<slug>--/` project subdir, renders `.md` sibling per session jsonl. Returns metrics `{sessions_pulled, bytes}`. Early-returns zero metrics if the source root doesn't exist.
- A new renderer binding for Codex sessions. Owns a normalizer (codex jsonl → `NormalizedSession`, pairing `function_call`/`function_call_output` and `custom_tool_call`/`custom_tool_call_output` by `call_id`, reconciling MCP dual-channel output by preferring `event_msg.mcp_tool_call_end` over the string `function_call_output` when both are present), a frontmatter schema + YAML serialiser, and a tool registry with bespoke entries for `exec_command` and `apply_patch` plus a fallback for everything else.
- A new renderer binding for Pi sessions. Owns a normalizer (pi jsonl → `NormalizedSession`, walking leaf → root from the current branch then reversing, substituting `compaction.summary` for entries before `firstKeptEntryId` on the active path, distinguishing the `bashExecution` user-escape role from LLM-issued `bash` tool calls), a frontmatter schema + YAML serialiser, and a tool registry with bespoke entries for `bash`, `read`, `edit` (using `details.diff`), `write` plus a fallback.

**Modules modified**

- The ingest main entry. Adds `ingestLocalCodex` and `ingestLocalPi` to the unconditional source list, with default source dirs.

**Architectural rules**

- Both sources follow `local-claude`'s file-based mtime-bucket pattern, not `local-opencode`'s SQLite-projection pattern. Source files are jsonl on disk; copying preserves their mtime semantics.
- Both renderer modules nest as `src/lib/<agent>/renderer/` per the project's deep-module naming convention. No imports cross from `src/lib/` into `src/ingest/`.
- All external data (jsonl rows) parsed with Zod (camelCase schema names, PascalCase inferred types) per project convention. Failures use `errore`-tagged errors.
- Per-agent state type drives the `RenderConfig<S>` generic. Codex state likely covers MCP call_id ↔ structured-result correlation; Pi state likely covers the leaf-walk path and compaction-substitution lookup. Both held in the normalizer where possible; renderer-level state minimal.
- Tool names are not normalised across agents. Codex's `apply_patch` and Claude's `Edit` are distinct keys in distinct registries — no shared "edit" key.
- Frontmatter stays per-agent. Codex carries `sessionId`, `cwd`, `startedAt`, `endedAt`, `turns`, `toolUses`, `originator`, `cliVersion`, `modelProvider`, `git`, `renderer`. Pi carries `sessionId`, `cwd`, `version`, `startedAt`, `parentSession`, `sessionName`, `latestProvider`, `latestModelId`, `thinkingLevel`, `totalTokens`, `cost`, `turns`, `toolUses`, `renderer`. Field sets are observed-driven, not derived from a unified shape.
- Wiring is unconditional in `main.ts`. Missing source dirs handled inside each source by `existsSync` early return to zero metrics (per the established missing-optional-file convention).

**Codex-specific decisions**

- Source layout flattens the date tree. `~/.codex/sessions/2026/05/27/rollout-*.jsonl` → `<day>/<machine>/codex/rollout-*.jsonl`.
- Codex memories pulled by recursive glob `**/*.md` under `~/.codex/memories/`. Destination preserves the subtree (`MEMORY.md`, `memory_summary.md`, `rollout_summaries/*.md`, `skills/<name>/SKILL.md`).
- Bespoke tool renderers: `exec_command` (parses the `Chunk ID/Wall time/Process exited with code/Original token count/Output:\n---\n…` blob format), `apply_patch` (renders the `*** Begin Patch … *** End Patch` script as a diff). Everything else (`write_stdin`, `update_plan`, all MCP) → fallback.
- MCP detection at normalize time via `function_call.namespace` matching `mcp__<server>__`. The paired structured `event_msg.mcp_tool_call_end` (matched by `call_id`) is preferred over the string `function_call_output`.
- Dropped during normalization: `event_msg.agent_message` (duplicates the final `response_item.message`), `event_msg.token_count`, lifecycle events (`task_started`, `task_complete`, `turn_aborted`), `reasoning` entries where `summary.length === 0` and `content === null` (encrypted-only — nothing to render).
- `message` entries: render with role + optional phase (`commentary` / `final_answer`). Developer-role messages are kept.

**Pi-specific decisions**

- Source layout preserves the `--<slug>--/` project subdir verbatim.
- Active-branch walk: identify the leaf (latest-mtime entry on the deepest chain, or all-children-less node), walk `parentId` up to a `parentId: null` root, reverse. Branches off this path are dropped in v1.
- Compaction substitution: if a `compaction` entry sits on the active path, all entries between the session header and `firstKeptEntryId` are replaced by a single rendered block containing `summary`.
- Bespoke tool renderers: `bash`, `read`, `edit` (special-cased to render `details.diff` from the tool result when present), `write`. Everything else → fallback.
- `bashExecution` role rendered distinctly from `bash` tool results (it's the user `!cmd` editor escape, not LLM output). `excludeFromContext:true` flagged visually so the reader knows it was display-only.
- `custom_message` entries dispatched through a small per-`customType` handler (empty registry in v1 — everything routes to a generic fallback that pretty-prints the payload). Bare `type:"custom"` entries (state, not in LLM context) skipped entirely.
- `model_change`, `thinking_level_change`, `session_info`, `label`, `branch_summary` rendered as small status lines inline where they appear on the active path. `label` resolves its `targetId` back-reference to render alongside the labeled entry.
- Schema validation tolerates the "contract-light" tool layer: `toolCall.arguments` and `toolResult.details` parsed as `Record<string, unknown>` / `unknown` at the Zod boundary, then narrowed per-tool inside each bespoke renderer.

**Verification gate**

- `bun check` clean is necessary and the primary gate. A spot-check pass against real local sessions (eyeballing rendered `.md` for one Codex session and one Pi session per project) is the secondary gate.

## Testing Decisions

**What makes a good test here**

External behaviour only, tested at the public seam of each module. The same fixture-in / observable-out style as the existing Claude and OpenCode renderer tests.

**Modules to test**

- The Codex normalizer (`src/lib/codex/renderer/normalize.test.ts`). Fixture jsonl in, expected `NormalizedSession` out. Cover: `function_call`/`function_call_output` pairing by `call_id`, `custom_tool_call`/`custom_tool_call_output` pairing, MCP dual-channel reconciliation (structured wins, string used when structured absent), dropped event types (`agent_message`, `token_count`, lifecycle), empty-reasoning filtering, developer-role messages preserved.
- The Codex frontmatter serialiser (`src/lib/codex/renderer/frontmatter.test.ts`). Fixture session-meta + summary stats in, expected YAML out.
- The Codex bespoke tool renderers (`src/lib/codex/renderer/tools.test.ts`). `exec_command` blob-parse → readable shell block; `apply_patch` patch script → diff; fallback round-trip for an unknown tool.
- The Codex end-to-end (`src/lib/codex/renderer/index.test.ts`). Small real-ish session jsonl in, expected `.md` out.
- The Pi normalizer (`src/lib/pi/renderer/normalize.test.ts`). Fixture jsonl in, expected `NormalizedSession` out. Cover: linear session (no branching) walks correctly; branching session with two leaves walks the latest leaf; compaction on the active path replaces pre-`firstKeptEntryId` history with the summary; `bashExecution` role separated from `bash` tool calls; `excludeFromContext` flag propagated; `custom_message` preserved, bare `custom` skipped; `label` resolves its `targetId`.
- The Pi frontmatter serialiser (`src/lib/pi/renderer/frontmatter.test.ts`). Fixture session header + accumulated state in, expected YAML out.
- The Pi bespoke tool renderers (`src/lib/pi/renderer/tools.test.ts`). `bash`, `read`, `edit` (with `details.diff`), `write`, plus fallback for an unknown tool.
- The Pi end-to-end (`src/lib/pi/renderer/index.test.ts`). Small real-ish session jsonl in, expected `.md` out, including one branching + compaction case.
- The Codex source (`src/ingest/sources/local-codex.test.ts`). Temp dir simulating `~/.codex/{sessions,memories}/`, in-window vs out-of-window mtime filtering, flattened destination layout, sessions_pulled and memories_pulled metrics, missing source dir → zero metrics.
- The Pi source (`src/ingest/sources/local-pi.test.ts`). Temp dir simulating `~/.pi/agent/sessions/--<slug>--/`, in-window vs out-of-window mtime filtering, project-subdir preservation, sessions_pulled metric, missing source dir → zero metrics.

**Prior art**

- `src/ingest/sources/local-claude.test.ts` covers the file-based mtime-bucket pattern (in-window filtering, day-bucket destination, `.md` sibling rendering) and is the template for both new source tests.
- `src/lib/claude/renderer/{normalize,frontmatter,tools,render}.test.ts` and `src/lib/opencode/renderer/{normalize,frontmatter,tools,index}.test.ts` are the templates for both new renderer test suites.
- `src/lib/opencode/pull/splitter.test.ts` demonstrates the temp-dir fixture pattern for filesystem-touching tests.

## Out of Scope

- SSH variants for Codex and Pi (`ssh-codex`, `ssh-pi`). Land as follow-up epics once the local sources stabilise.
- Bespoke Codex tool renderers for `write_stdin`, `update_plan`, MCP per-server. Fallback in v1; add bespoke only on first sighting in a real session.
- Bespoke Pi renderers for extension `custom_message` types (scheduler-task, scheduler-deleted, pi-splash). Generic fallback in v1; add per-`customType` renderers only if quality demands it.
- Pi "full tree" rendering (showing every branch). Active-branch-only in v1; add as opt-in mode later.
- Codex aux files beyond memories: `AGENTS.md` (global instructions, not memory), `rules/`, `history.jsonl` (global command history), `session_index.jsonl`, `auth.json`, `cache/`, `plugins/`. None pulled in v1.
- Pi aux files: `auth.json`, `settings.json`, `skills/`, `extensions/`. None pulled in v1 (Pi has no memory concept; the rest are config or credentials).
- Cross-agent frontmatter unification. Each agent owns its own field set.
- Tool-name normalisation across agents.
- Re-rendering of historical jsonl already in the data lake. The sources only render on copy; historical files are unchanged unless re-pulled in a backfill window.

## Further Notes

- Codex memories are global per machine (no per-project segment), and Codex itself manages the directory as generated state (per the upstream docs, "treat these files as generated state... don't rely on editing them by hand"). The mtime-bucket strategy works because Codex rewrites the files whenever its consolidation pipeline runs.
- Pi's session-format spec is deliberately contract-light at the tool layer (`arguments` and `details` typed as `any`). The Zod schemas at the normalizer boundary should parse permissively and let each bespoke tool renderer narrow per-tool.
- The Pi corpus has 49 local sessions today; 48 are linear (single leaf, no branching) and 1 has compaction. The active-branch walk degenerates to top-to-bottom order in the common case, so the tree-walking cost only matters when branching actually exists.
- The Codex corpus has 2 local sessions today, so the bespoke tool list (`exec_command`, `apply_patch`) is observation-driven against a thin sample. The fallback path covers anything new; bespoke renderers added on first sighting.
- The brainstorm record (transcripts of the source analysis, including jq snippets and tool-shape tables for both agents) lives in deep-research memory at `~/.claude/agent-memory/deep-research/reference_codex_memory_layout.md` and the conversation history of dream-gt5l. Useful for refresher when extending either binding.

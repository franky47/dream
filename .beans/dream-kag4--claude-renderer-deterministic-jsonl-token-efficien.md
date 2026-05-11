---
# dream-kag4
title: 'Claude renderer: deterministic JSONL → token-efficient markdown'
status: todo
type: epic
priority: high
created_at: 2026-05-11T13:03:41Z
updated_at: 2026-05-11T13:03:41Z
---

## Problem Statement

Dream's ingest phase pulls Claude Code session JSONL from m4x and from remote hosts into per-session files. A downstream summarising agent — currently a local 256k-context model (Gemma/Qwen at q4) — reads those JSONL transcripts to produce per-session `description` + `learnings` records.

The raw JSONL is too verbose for that consumer. A single session in the ingested data hits 1 MB of user content + 800 KB of assistant content, dominated by `tool_result` payloads (entire file Reads, full Bash stdouts, redundant Edit before/after pairs), assistant `thinking` blocks, and meta entries that carry no signal for summarisation (`file-history-snapshot`, `last-prompt`, `permission-mode`, `queue-operation`, `attachment`, raw `system`). A throwaway Python prototype in `prototype-py/` already validated that a coarse strip-pass (keep user/assistant text, drop tool payloads, keep tool-name breadcrumbs) is the right direction — but it throws away too much signal at once (entire `tool_use` inputs, all Edit/Write bodies, all Bash output), and it isn't part of the Bun pipeline.

The Python prototype is also wrong-direction for the long run: it consumes JSONL at LLM-call time inside the summariser, which means every prompt iteration re-pays the strip cost and every renderer-bug fix lives in throwaway Python.

## Solution

A deterministic Bun-based markdown renderer that runs as part of `bun run ingest`, producing a sibling `<sessionId>.md` next to each pulled `<sessionId>.jsonl`. The renderer lives in a new deep module `src/lib/claude/renderer/`. Layout is domain-first, function-second: Claude grows its `renderer/` subfolder now (and could later add `pull/` if pull-side helpers emerge), and the existing flat `src/lib/opencode/` lib (currently pull-only) is refactored into `src/lib/opencode/pull/` so the future `src/lib/opencode/renderer/` lands as a sibling under the same domain folder.

The render format is a structured-but-readable markdown dialect tuned for a 256k-context local model:

- **YAML frontmatter** with `sessionId`, `cwd`, `project`, `startedAt`, `endedAt`, `turns`, `title`, `toolUses`, `renderer` version.
- **Self-closing turn markers**: `<turn n="N" role="user|assistant" t="0|+MMmSSs"/>`. The body of a turn follows until the next `<turn …/>` or EOF. No closing tag, no nesting.
- **Unified `<tool>` element** for tool calls: `<tool name="…" attr="…" …>…body…</tool>` or self-closing `<tool …/>` when no body is needed. Bodies are unfenced (no triple-backtick wrapping) — the closing tag on its own line is the boundary, avoiding backtick-escape hazards for code-bearing outputs.
- **Per-tool reducers**, each contributing one switch case in the renderer's tool-dispatch:
  - `Read` / `Glob` / `Grep` — self-closing, inputs only (path/pattern), body dropped.
  - `Edit` — body is a unified diff produced by the `diff` package; consecutive same-file Edits coalesce into one element with `patches="N"` attribute and the diffs back-to-back; no `@@ line @@` numbers (the file's state at that point in history isn't recoverable).
  - `Write` — `lines` + `bytes` attrs; body verbatim ≤ 60 lines, otherwise head 30 + tail 10 with elision marker.
  - `Bash` — `cmd` + `exit` attrs; output body head 40 + tail 40 past 200 lines or 8 KB (always preserving tail so errors survive).
  - `Agent` — `description` attr; body has the truncated subagent prompt followed by the truncated result.
  - `Skill` — self-closing, `args` attr only.
  - `WebFetch` / `WebSearch` — URL/query attr only, body dropped.
  - `TodoWrite` — single-line state diff.
  - `AskUserQuestion` — list of `Q: … → A: …`.
  - Unknown / future tools — fallback to `<tool name="…">` with key inputs and same head+tail truncation as Bash.
- **Universal post-passes**: ANSI escape strip; trailing whitespace trim; runs of ≥ 3 blank lines collapsed to 1; exact-byte tool_result deduplication replaces a repeat body with `(same output as turn N)`.
- **Dropped entirely**: assistant `thinking` blocks; `file-history-snapshot`, `last-prompt`, `permission-mode`, `queue-operation`, `attachment` entries; raw `system` entries. The `ai-title` entry is consumed only into frontmatter.
- **User text stripped of**: `<system-reminder>` blocks (hook-output noise, mostly CLAUDE.md re-injection), `<command-name>`/`<command-message>`/`<command-args>` framing tags (slash-command invocations surface as one line `[/skill args="…"]`), `<local-command-stdout>` blobs.
- **Title fallback chain**: `ai-title` → first user text first 80 chars after framing-strip → `(untitled)`.

The renderer is a pure function: `renderClaudeSession(jsonlText: string): string`. It does no filesystem I/O. The ingest sources (`src/ingest/sources/local-claude.ts` and `ssh-claude.ts`) call the renderer after writing each `<sessionId>.jsonl` and write the returned markdown to the sibling `<sessionId>.md`. There is no separate `bun run render` command — everything happens inside `bun run ingest`. The raw JSONL is kept on disk as a sibling so the summarising agent can drop down to it for details the markdown truncated.

The disk layout's `raw/` segment is dropped now that raw and rendered are siblings: paths move from `data/raw/<machine>/<source>/<encoded-cwd>/<id>.{jsonl}` to `data/<machine>/<source>/<encoded-cwd>/<id>.{jsonl,md}`. The orchestrator's wipe target, `package.json` clean scripts, and any path constants follow the rename.

## User Stories

1. As a Dream operator, I want every Claude session JSONL pulled by ingest to have a sibling `<sessionId>.md` produced in the same pass, so a single `bun run ingest` command leaves me with both raw and rendered forms ready for downstream consumption.
2. As a Dream operator, I want the rendered markdown to live next to the JSONL it came from, so the summarising agent can `grep` the markdown and `Read` the JSONL slice when it needs detail the renderer truncated.
3. As a Dream operator, I want the rendered markdown to be deterministic given the same JSONL input, so re-rendering after a renderer change produces byte-identical output for unchanged sessions and tests can use fixture comparison.
4. As a Dream operator, I want re-rendering after a renderer change to happen by re-running `bun run ingest`, so there is exactly one ingest command surface to remember.
5. As a Dream operator, I want deep modules organised domain-first under `src/lib/<domain>/<function>/` (this epic adds `src/lib/claude/renderer/` and migrates the existing `src/lib/opencode/` contents into `src/lib/opencode/pull/`), so each domain's pull-side and render-side code lives under one folder while staying separated by function.
6. As a Dream operator, I want the `raw/` segment dropped from `data/` paths once rendered files are siblings of JSONLs, so the layout name no longer implies a separate-trees-for-raw-and-derived model that doesn't exist.
7. As a Dream operator, I want both `local-claude` and `ssh-claude` sources to call the same renderer module after pull, so the two transports stay differentiated only by how they obtain the JSONL.
8. As the summarising agent, I want a YAML frontmatter at the top of each rendered file with `sessionId`, `cwd`, `project`, `startedAt`, `endedAt`, `turns`, `title`, `toolUses`, and renderer version, so I can filter and route sessions without reading the body.
9. As the summarising agent, I want turn boundaries marked with self-closing `<turn n="N" role="…" t="…"/>` lines that won't collide with markdown headings inside tool output, so I can navigate the transcript without ambiguity from pasted markdown content.
10. As the summarising agent, I want a wall-clock time-delta attribute on each turn marker (`t="+4m12s"`), so I can identify long debug stalls vs quick wins as a signal for weighting.
11. As the summarising agent, I want tool calls wrapped in a single `<tool name="…" …>` element regardless of tool kind, so I have one tag family to grep against and unknown tools render through the same path.
12. As the summarising agent, I want tool bodies unfenced (no triple-backtick wrapping), so tool outputs that contain code or markdown don't require escape handling on the renderer side or on my parsing side.
13. As the summarising agent, I want `Read`, `Glob`, and `Grep` tool calls to render as self-closing elements carrying only their inputs, so I'm not paying token cost for retrieval-side payloads that the assistant's subsequent text already references.
14. As the summarising agent, I want consecutive `Edit` calls on the same file coalesced into a single `<tool name="Edit" file="…" patches="N">` block with the diffs back-to-back, so I see a file's evolution in one place rather than fragmented across many small elements.
15. As the summarising agent, I want each `Edit` rendered as a unified diff (one body) rather than separate `old_string` / `new_string` blocks, so I get a roughly token-halved representation when the strings share context lines.
16. As the summarising agent, I want `Write` bodies kept verbatim up to a small threshold and head+tail-truncated past it (with line count and byte size in the header attrs), so I see the full content of small writes but don't drown in large generated files.
17. As the summarising agent, I want `Bash` outputs head+tail-truncated past a length threshold with the tail always preserved, so error messages and test-failure summaries at the end of long stdouts survive even when the body is elided.
18. As the summarising agent, I want every tool body run through an ANSI escape stripper, so terminal color codes don't burn tokens or confuse my parsing.
19. As the summarising agent, I want consecutive identical lines collapsed and exact-byte tool_result repeats replaced with `(same output as turn N)`, so I'm not paying for the same content twice within a session.
20. As the summarising agent, I want assistant `thinking` blocks dropped entirely from the rendered output, so I'm reading the assistant's actions and outcomes (ground truth) rather than its speculative reasoning paths.
21. As the summarising agent, I want `<system-reminder>` blocks and `<command-*>` framing tags stripped from user text, so the per-turn CLAUDE.md re-injection and hook-output framing don't masquerade as user intent.
22. As the summarising agent, I want slash-command invocations surfaced as a one-line `[/skill args="…"]` after framing-strip, so I retain the signal of "user invoked this skill" without the verbose framing.
23. As the summarising agent, I want low-signal meta entries (`file-history-snapshot`, `last-prompt`, `permission-mode`, `queue-operation`, `attachment`, raw `system`) dropped entirely from the rendered output, so my context budget is spent on conversation and tool activity.
24. As the summarising agent, I want the rendered file title taken from the `ai-title` entry when present and fall back to the first 80 characters of the first real user text otherwise (with `(untitled)` as last resort), so every session has a usable title even though `ai-title` covers only ~10% of sessions.
25. As a Dream operator, I want unknown tool names (custom Skills, MCP tools, future built-ins) to render through a fallback case that uses the same `<tool name="…">` shape with truncated body, so the renderer never crashes on a tool it doesn't know about and renderer updates only need new cases for tools that benefit from a custom reducer.

## Implementation Decisions

- New deep module **`src/lib/claude/renderer/`** with public entry point `renderClaudeSession(jsonlText: string): string`. The pure-function shape means tests use string fixtures with no filesystem, and the ingest sources are the only place that touches disk.
- Refactor existing **`src/lib/opencode/`** (currently `projection.ts`, `splitter.ts`, `index.ts`) into **`src/lib/opencode/pull/`** in the same epic, so the domain-first layout is consistent from the moment this epic lands. Imports in `local-opencode.ts` / `ssh-opencode.ts` shift from `#lib/opencode` to `#lib/opencode/pull`. The future `src/lib/opencode/renderer/` will land as a sibling.
- Internal modules:
  - **frontmatter** — Zod-parsed JSONL entries → frontmatter object → YAML string. Pulls `ai-title`, scans entries for `cwd`, derives `project` from `basename(cwd)`, walks for first/last `timestamp`, counts user turns and tool_uses. Title fallback chain implemented here.
  - **truncate** — pure string helpers: ANSI strip, head+tail (`headTailLines`, `headTailBytes`), blank-run collapse, exact-byte hash dedup against a per-session `Map<hash, turnNumber>`.
  - **tools** — per-tool reducers as a `switch` on the tool name, each returning the element string for its tool call. The Edit reducer uses the `diff` package (npm `diff`, with official `@types/diff`) to produce unified diffs; consecutive same-file Edits are coalesced at the renderer level before dispatch.
  - **render** — top-level orchestrator: parses JSONL line-by-line, drops dropped types, collects frontmatter inputs, walks user/assistant entries emitting `<turn …/>` markers and dispatching tool_use/tool_result through the tools module.
- Tool dispatch handles tools by name with a per-tool case; unknown tools fall through to a generic case using head+tail truncation. New built-in tools or commonly-used custom tools (Skills/MCP) may earn their own case when their generic rendering wastes tokens.
- The `<turn>` element is self-closing (`/`-prefix close) acting as a start-of-turn marker. The renderer numbers turns monotonically per JSONL entry order: every user entry bumps the counter, every assistant entry continuing after a tool_result also bumps. The first turn carries `t="0"`; subsequent turns carry `t="+MMmSSs"` deltas computed from JSONL `timestamp` fields. When timestamps are missing, the delta is omitted from that turn.
- The `<tool>` element wraps every tool call. Bodies are unfenced. Closing tags appear on their own line. Self-closing form (`<tool … />`) is used when the body would be empty under the per-tool policy.
- Truncation thresholds (Bash 200 lines / 8 KB, Write 60 lines, head/tail splits) are constants in the renderer module, intentionally not configuration: they're tuned once for the target consumer and changing them is a renderer-version bump, not a per-call decision.
- Universal post-passes applied to every tool body: ANSI strip (regex), trailing whitespace trim, ≥ 3 consecutive blank lines → 1. Exact tool_result dedup runs at the renderer level (the dispatch tracks a hash → turn-number map per session) so the renderer can replace a body with `(same output as turn N)` without per-tool cooperation.
- The `Source` interface in `src/ingest/orchestrator.ts` is unchanged. Sources whose pulled format isn't already token-efficient (Claude, future OpenCode) call into their renderer library at the end of `pull()` and write the rendered file as a sibling. Sources whose pulled format is already token-efficient (Firefox CSV) do nothing extra.
- The orchestrator's `rm -rf outDir` wipe is kept — it now wipes both JSONL and MD siblings together, which is correct because they're produced atomically in a single `pull()` invocation.
- Disk layout migrates from `data/raw/<machine>/<source>/…` to `data/<machine>/<source>/…`. The migration touches `src/ingest/orchestrator.ts` (the `outDir` join), the `clean:raw` and `clean:legacy-claude-sessions` scripts in `package.json`, and any path constants in `src/ingest/sources/`. `data/raw/` directories existing on disk from prior runs are removed manually as part of the migration; the new layout starts empty.
- Renderer version is recorded in the YAML frontmatter (`renderer: claude-md@1`) so the rendered files declare which renderer produced them; future format breaks are signalled by a version bump rather than silent change.
- Dependencies added: `diff` (with `@types/diff`) for unified-diff production. No other runtime deps; ANSI strip and blank-collapse are short regex helpers.

## Testing Decisions

- The pure-function entry point `renderClaudeSession(jsonlText: string): string` is the primary external behaviour. Tests assert against the rendered string, not against intermediate data structures, parser internals, or which post-pass produced which transformation.
- Tests are **fixture-driven**: small hand-crafted JSONL strings inlined in tests cover each rendering case (one Read, one Edit, two consecutive same-file Edits, a Bash with short output, a Bash with long output triggering truncation, a Write under threshold, a Write over threshold, a tool_result exact-repeat, a tool with ANSI codes, a `<system-reminder>`-laden user message, a missing-`ai-title` session, a session whose first user text is a slash command). Each fixture is small enough to read inline and assert specific substrings or full output.
- No real personal user data in tests — memory `feedback_no_real_user_data` applies. Fixtures synthesise plausible JSONL entry shapes.
- **Modules with co-located tests** (`*.test.ts` next to source per project convention):
  - `frontmatter.test.ts` — title fallback chain, project derivation, timestamp bounds, turn count, tool_uses count, missing-fields tolerance.
  - `truncate.test.ts` — ANSI strip, head/tail line and byte modes, blank-run collapse, dedup map behaviour.
  - `tools.test.ts` — one test per per-tool reducer covering happy path + threshold boundary + empty-input case.
  - `render.test.ts` — end-to-end fixture comparison for representative whole-session inputs, including the multi-tool coalescing case and the universal post-passes interacting.
- Prior art for this style of test:
  - `src/lib/opencode/projection.test.ts` and `splitter.test.ts` for fixture-driven deep-module testing.
  - `src/ingest/sources/local-firefox.test.ts` for the source-level integration shape.
- Source-level tests for `local-claude.ts` and `ssh-claude.ts` extend their existing tests with one assertion that a sibling `.md` file is produced for each `.jsonl` file written. The renderer logic itself is not retested at the source level — those tests verify the wiring, not the rendering.
- `bun run check` (fmt + lint + typecheck + test + knip) is the verification command for every step. No bespoke commands.

## Out of Scope

- The summarising agent itself. This epic produces the markdown; the LLM-side pipeline that consumes it stays in the Python prototype for now and is its own future epic.
- The OpenCode renderer (`src/lib/opencode/renderer/`). That counterpart is a future epic; this epic establishes the domain-first layout (and migrates `src/lib/opencode/` into `src/lib/opencode/pull/`) so the renderer slots in cleanly, but does not implement it.
- Cross-session deduplication, learnings dedup, or any multi-session synthesis. Each rendered file is a per-session view.
- A queryable store (sqlite) over rendered files. HANDOFF.md mentions this as a future direction; it is a separate epic that consumes rendered files.
- Configurable truncation thresholds. Thresholds are baked-in constants; the renderer version field exists precisely so future tuning is a versioned format change rather than runtime configuration.
- Backwards-compatible markdown output for pre-v1 renderer consumers. The renderer is new; there is no v0 to be compatible with.
- A separate `bun run render` CLI verb. The decision is to keep ingest as the single command surface; renderer iteration accepts the small cost of re-running ingest.
- Inclusion of assistant `thinking` blocks. Dropped for the foreseeable future; a `--include-thinking` flag is a possible future addition but not part of this epic.
- Sub-agent (`isSidechain: true`) handling beyond what the ingest already excludes. Subagent transcripts aren't pulled in the first place.
- Migration of FUTURE.md or HANDOFF.md references to the old `data/raw/…` paths. They stay as historical context.

## Further Notes

- The throwaway Python prototype in `prototype-py/` (summarise.py, batch.py, compare3.py) stays in the repo as reference for prompt iteration. Once the rendered markdown is feeding a Bun-side summariser, the Python prototype can be deleted in a follow-up cleanup — not part of this epic.
- The `renderer: claude-md@1` version field in frontmatter is the seam for the next iteration: if truncation thresholds, tool reducers, or tag attributes change in a way that breaks downstream parsing, bump to `@2` and downstream code can branch on the version.
- The summarising agent's existing Python prompts (v5 in `prototype-py/summarise.py`) work against the current Python-side string compression. They will need a light revision once they're fed the new markdown format — likely just the system prompt prelude describing `<turn>` and `<tool>` semantics. That revision is part of the future summariser epic, not this one.
- Vertical slices for `prd-to-issues`: the natural split is roughly (1) `src/lib/opencode/` → `src/lib/opencode/pull/` refactor (small, self-contained, lands the domain-first layout), (2) frontmatter + truncate primitives under `src/lib/claude/renderer/`, (3) tools module with the four high-volume reducers (Read/Glob/Grep, Edit, Write, Bash) and a generic fallback, (4) render orchestrator + the remaining per-tool cases, (5) wiring into `local-claude` + `ssh-claude` + path migration to drop `raw/`. Each slice is independently mergeable; slice 5 is the user-visible "ingest now produces markdown" moment.

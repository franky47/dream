---
# dream-sohj
title: Codex local source + renderer (fallback-only) + memories pull
status: todo
type: feature
created_at: 2026-05-28T14:25:32Z
updated_at: 2026-05-28T14:25:32Z
parent: dream-gt5l
---

## What to build

First tracer bullet for Codex ingest. A new local source pulls in-window `~/.codex/sessions/**/*.jsonl` (flattened destination, no source date tree) and `~/.codex/memories/**/*.md` (recursive, subtree preserved) into the data lake, then renders a `.md` sibling per session jsonl. Renderer routes all tools through a generic fallback (no bespoke shapes yet); noise events are dropped at normalize time. After this slice, every Codex session in the configured window has a browsable markdown sibling and the codex memory tree is captured by mtime.

See parent PRD dream-gt5l "Solution" and "Codex-specific decisions" for the layout, noise-drop rules, and frontmatter field set.

## Acceptance criteria

- [ ] `ingestLocalCodex({machine, sourceDir})` returns a `Source` shaped like `ingestLocalClaude`; default `sourceDir` is `~/.codex`.
- [ ] Sessions copied flat to `<day>/<machine>/codex/rollout-*.jsonl`, bucketed by file mtime, in-window filter on `[since, until)`.
- [ ] Memories copied with subtree preserved to `<day>/<machine>/codex/memories/<rel>`, bucketed by file mtime.
- [ ] Metrics returned: `{sessions_pulled, memories_pulled, bytes}`.
- [ ] Missing `~/.codex/sessions` or `~/.codex/memories` → zero metrics for that arm, no failure.
- [ ] `src/lib/codex/renderer/` exports `renderCodexSession(jsonl) → string` built atop the generic `src/lib/renderer/` core.
- [ ] Normalizer pairs `function_call`/`function_call_output` and `custom_tool_call`/`custom_tool_call_output` by `call_id`; MCP `function_call` (namespaced `mcp__*`) is reconciled with the paired `event_msg.mcp_tool_call_end` structured record when present (structured wins).
- [ ] Dropped at normalize time: `event_msg.agent_message`, `event_msg.token_count`, lifecycle events (`task_started`, `task_complete`, `turn_aborted`), `reasoning` entries where `summary.length === 0` and `content === null`.
- [ ] All tool calls render through a single fallback (XML-attribute projection of `input`, mirroring opencode v1).
- [ ] Frontmatter carries: `sessionId`, `cwd`, `startedAt`, `endedAt`, `turns`, `toolUses`, `originator`, `cliVersion`, `modelProvider`, `git`, `renderer`.
- [ ] Wired into `src/ingest/main.ts` unconditionally (parallel to `ingestLocalClaude`/`ingestLocalOpencode`).
- [ ] Co-located tests for source (temp-dir mtime/window filtering, flatten, memories subtree, missing-dir zero metrics), normalizer (pairing, MCP reconciliation, noise drops), frontmatter, and an end-to-end `renderCodexSession` fixture test.
- [ ] `bun check` clean.

## User stories addressed

- User story 1
- User story 2
- User story 4
- User story 5
- User story 8
- User story 9
- User story 10
- User story 17
- User story 18
- User story 19
- User story 20
- User story 24

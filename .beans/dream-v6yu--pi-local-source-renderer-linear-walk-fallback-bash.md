---
# dream-v6yu
title: Pi local source + renderer (linear walk, fallback, bashExecution-aware)
status: completed
type: feature
priority: normal
created_at: 2026-05-28T14:25:33Z
updated_at: 2026-05-28T16:55:00Z
parent: dream-gt5l
---

## What to build

First tracer bullet for Pi ingest. A new local source pulls in-window `~/.pi/agent/sessions/--<slug>--/*.jsonl` into the data lake preserving the project subdir, then renders a `.md` sibling per session. The renderer walks the active branch leaf → root, reverses, and emits a linear transcript. `bashExecution` role entries (the `!cmd` editor escape) are distinguished from LLM-issued `bash` tool calls; `excludeFromContext:true` entries are flagged. All tools route through a generic fallback. Compaction substitution and bespoke tool renderers are deferred to follow-up slices. After this slice, every Pi session in the configured window has a browsable markdown sibling that matches what the Pi TUI would show "now" for the 48/49 sessions that don't involve compaction.

See parent PRD dream-gt5l "Solution" and "Pi-specific decisions" for the active-branch walk, frontmatter fields, and contract-light tool layer note.

## Acceptance criteria

- [x] `ingestLocalPi({machine, sourceDir})` returns a `Source`; default `sourceDir` is `~/.pi/agent`.
- [x] Sessions copied to `<day>/<machine>/pi/<project-slug>/<filename>.jsonl`, preserving the `--<slug>--/` source subdir, bucketed by file mtime, in-window filter on `[since, until)`.
- [x] Metrics returned: `{sessions_pulled, bytes}`.
- [x] Missing `~/.pi/agent/sessions` → zero metrics, no failure.
- [x] `src/lib/pi/renderer/` exports `renderPiSession(jsonl) → string` built atop the generic `src/lib/renderer/` core.
- [x] Normalizer walks leaf → root via `parentId` links from the latest-mtime leaf, then reverses. Branches off the active path are dropped in v1.
- [x] `bashExecution` role rendered distinctly from `bash` tool results in the output (e.g. user-shell-escape framing vs assistant-tool-output framing).
- [x] `excludeFromContext: true` entries rendered with a visible flag indicating display-only.
- [x] All `toolCall.name` values render through a generic fallback (XML-attribute projection of `arguments`).
- [x] `custom_message` entries route through the fallback for now; bare `type:"custom"` entries skipped.
- [x] Zod schemas at the boundary parse permissively: `toolCall.arguments` as `Record<string, unknown>`, `toolResult.details` as `unknown`.
- [x] Frontmatter carries: `sessionId`, `cwd`, `version`, `startedAt`, `parentSession`, `renderer`, plus whichever of `sessionName`, `latestProvider`, `latestModelId`, `thinkingLevel`, `totalTokens`, `cost`, `turns`, `toolUses` are derivable from the active-path entries.
- [x] Wired into `src/ingest/main.ts` unconditionally.
- [x] Co-located tests for source (temp-dir mtime/window filtering, project subdir preservation, missing-dir zero metrics), normalizer (linear session walks correctly; branching session with two leaves walks the latest; `bashExecution` separated from `bash` tool calls; `excludeFromContext` flag propagated), frontmatter, end-to-end `renderPiSession` fixture test.
- [x] `bun check` clean.

## User stories addressed

- User story 1
- User story 3
- User story 11
- User story 15
- User story 16
- User story 17
- User story 18
- User story 19
- User story 20
- User story 24

## Summary of Changes

- `src/lib/pi/renderer/`: new renderer binding atop the generic `src/lib/renderer/` core.
  - `entries.ts`: jsonl → `PiTree` (header + node map + childrenById index) and active-path walk (latest-timestamp leaf → root, reversed). Permissive `passthrough` schema for nodes, dedup on first id, cycle guard, orphan-parent tolerant.
  - `frontmatter.ts`: `extractFrontmatter(jsonlText)` for ad-hoc use and `buildFrontmatter(tree)` for callers that already parsed. Counts user-role messages as turns, `toolCall` content parts as toolUses, accumulates usage.totalTokens and usage.cost.total along the active path. `latestProvider`/`latestModelId`/`thinkingLevel`/`sessionName` come from the last respective entry on the active path.
  - `normalize.ts`: `normalize(jsonlText)` / `normalizeTree(tree)` build `NormalizedSession`. `bashExecution` becomes a user-role message with a single `bashExecution` tool part (exit-code-aware `isError`, `excludeFromContext` surfaced). `toolResult` attaches to its pending `toolCall` by `toolCallId`. `custom_message` flows through as a user-role tool part named after `customType`. Bare `type:"custom"` and small status entries (`model_change`, `thinking_level_change`, `session_info`, `label`, `branch_summary`, `compaction`) skipped.
  - `tools.ts`: `piFallback` — generic XML-attribute projection of scalar inputs, error="1" on tool failure.
  - `index.ts`: `renderPiSession(jsonlText)` — parses the tree once, threads it through normalize + frontmatter.
- `src/ingest/sources/local-pi.ts`: new `Source` glob/copies `<sourceDir>/sessions/**/*.jsonl` by mtime into `<day>/<machine>/pi/<rel>` (preserving the `--<slug>--/` subdir), renders the `.md` sibling. Missing `sessions/` → zero metrics, no failure.
- `src/ingest/main.ts`: wires `ingestLocalPi({ machine, sourceDir: ~/.pi/agent })` unconditionally.
- `package.json`: adds `#lib/pi/renderer` subpath import.

Tests added (40 new across 5 files): `entries.test.ts`, `frontmatter.test.ts`, `normalize.test.ts`, `tools.test.ts`, `index.test.ts`, `local-pi.test.ts`.

### Follow-ups

- Compaction substitution on the active path (one observed session needs it).
- Bespoke renderers for `bash`, `read`, `edit` (using `details.diff`), `write`.
- ssh-pi source.
- Bespoke `custom_message` handlers per `customType` (currently fallback only).

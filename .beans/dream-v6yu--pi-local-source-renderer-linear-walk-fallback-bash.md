---
# dream-v6yu
title: Pi local source + renderer (linear walk, fallback, bashExecution-aware)
status: todo
type: feature
created_at: 2026-05-28T14:25:33Z
updated_at: 2026-05-28T14:25:33Z
parent: dream-gt5l
---

## What to build

First tracer bullet for Pi ingest. A new local source pulls in-window `~/.pi/agent/sessions/--<slug>--/*.jsonl` into the data lake preserving the project subdir, then renders a `.md` sibling per session. The renderer walks the active branch leaf → root, reverses, and emits a linear transcript. `bashExecution` role entries (the `!cmd` editor escape) are distinguished from LLM-issued `bash` tool calls; `excludeFromContext:true` entries are flagged. All tools route through a generic fallback. Compaction substitution and bespoke tool renderers are deferred to follow-up slices. After this slice, every Pi session in the configured window has a browsable markdown sibling that matches what the Pi TUI would show "now" for the 48/49 sessions that don't involve compaction.

See parent PRD dream-gt5l "Solution" and "Pi-specific decisions" for the active-branch walk, frontmatter fields, and contract-light tool layer note.

## Acceptance criteria

- [ ] `ingestLocalPi({machine, sourceDir})` returns a `Source`; default `sourceDir` is `~/.pi/agent`.
- [ ] Sessions copied to `<day>/<machine>/pi/<project-slug>/<filename>.jsonl`, preserving the `--<slug>--/` source subdir, bucketed by file mtime, in-window filter on `[since, until)`.
- [ ] Metrics returned: `{sessions_pulled, bytes}`.
- [ ] Missing `~/.pi/agent/sessions` → zero metrics, no failure.
- [ ] `src/lib/pi/renderer/` exports `renderPiSession(jsonl) → string` built atop the generic `src/lib/renderer/` core.
- [ ] Normalizer walks leaf → root via `parentId` links from the latest-mtime leaf, then reverses. Branches off the active path are dropped in v1.
- [ ] `bashExecution` role rendered distinctly from `bash` tool results in the output (e.g. user-shell-escape framing vs assistant-tool-output framing).
- [ ] `excludeFromContext: true` entries rendered with a visible flag indicating display-only.
- [ ] All `toolCall.name` values render through a generic fallback (XML-attribute projection of `arguments`).
- [ ] `custom_message` entries route through the fallback for now; bare `type:"custom"` entries skipped.
- [ ] Zod schemas at the boundary parse permissively: `toolCall.arguments` as `Record<string, unknown>`, `toolResult.details` as `unknown`.
- [ ] Frontmatter carries: `sessionId`, `cwd`, `version`, `startedAt`, `parentSession`, `renderer`, plus whichever of `sessionName`, `latestProvider`, `latestModelId`, `thinkingLevel`, `totalTokens`, `cost`, `turns`, `toolUses` are derivable from the active-path entries.
- [ ] Wired into `src/ingest/main.ts` unconditionally.
- [ ] Co-located tests for source (temp-dir mtime/window filtering, project subdir preservation, missing-dir zero metrics), normalizer (linear session walks correctly; branching session with two leaves walks the latest; `bashExecution` separated from `bash` tool calls; `excludeFromContext` flag propagated), frontmatter, end-to-end `renderPiSession` fixture test.
- [ ] `bun check` clean.

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

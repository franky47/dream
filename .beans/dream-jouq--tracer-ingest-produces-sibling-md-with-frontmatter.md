---
# dream-jouq
title: 'Tracer: ingest produces sibling .md with frontmatter, turns, generic tool fallback; drop raw/ segment'
status: todo
type: feature
priority: high
created_at: 2026-05-11T13:33:54Z
updated_at: 2026-05-11T13:33:54Z
parent: dream-kag4
blocked_by:
    - dream-u671
---

## What to build

The tracer-bullet slice: `bun run ingest` produces a sibling `<sessionId>.md` next to every `<sessionId>.jsonl` pulled by the Claude sources. End-to-end demoable — rendered files are correct and self-describing, just not yet optimally compressed (per-tool reducers and universal post-passes land in subsequent slices).

Scope:

- New deep module `src/lib/claude/renderer/` with public entry point `renderClaudeSession(jsonlText: string): string`. Pure function, no filesystem.
- Internal sub-modules (frontmatter extraction, turn-marker emission, generic tool dispatch) per parent PRD's Implementation Decisions.
- YAML frontmatter (`sessionId`, `cwd`, `project`, `startedAt`, `endedAt`, `turns`, `title`, `toolUses`, `renderer: claude-md@1`). Title fallback chain: `ai-title` → first user text first 80 chars (post-strip) → `(untitled)`.
- Self-closing `<turn n="N" role="user|assistant" t="0|+MMmSSs"/>` markers between turn bodies. First turn `t="0"`; subsequent turns are deltas computed from JSONL `timestamp` fields; delta omitted when timestamp missing.
- Generic `<tool name="..." attr="..." .../>` self-closing fallback for *every* tool call (no specialised reducers in this slice — those land in slices 3 and 4). The fallback carries the tool's name and a flat attribute projection of its input; bodies are dropped at this layer.
- Drop on the way in: assistant `thinking` blocks; `file-history-snapshot`, `last-prompt`, `permission-mode`, `queue-operation`, `attachment` entries; raw `system` entries. `ai-title` consumed only into frontmatter.
- Strip from user text: `<system-reminder>` blocks, `<command-name>` / `<command-message>` / `<command-args>` framing tags, `<local-command-stdout>` blobs. Slash-command invocations surface as a one-line `[/skill args="..."]`.
- Wire `src/ingest/sources/local-claude.ts` and `src/ingest/sources/ssh-claude.ts`: after writing each `<sid>.jsonl`, read it back, call the renderer, write `<sid>.md` as a sibling. The orchestrator's `rm -rf outDir` wipe is unchanged — it now wipes both siblings together, which is correct.
- Path migration: drop the `raw/` segment everywhere. `data/raw/<machine>/<source>/...` → `data/<machine>/<source>/...`. Touches `src/ingest/orchestrator.ts` (the `outDir` join), `package.json` scripts (`clean:raw`, `clean:legacy-claude-sessions`), and any path constants in `src/ingest/sources/`. Pre-existing `data/raw/` directories on disk are removed as part of the migration; the new layout starts empty.

See parent PRD dream-kag4 — sections "Solution", "Implementation Decisions", and "Testing Decisions".

## Acceptance criteria

- [ ] `src/lib/claude/renderer/` exists with `renderClaudeSession(jsonlText: string): string` as the public entry point.
- [ ] Frontmatter has all fields in PRD: sessionId, cwd, project, startedAt, endedAt, turns, title, toolUses, renderer.
- [ ] Title fallback chain implemented and tested (ai-title present, ai-title absent, slash-command-only first user message).
- [ ] `<turn n="" role="" t=""/>` markers emitted between turn bodies; deltas computed from timestamps; first turn `t="0"`.
- [ ] Every tool call renders as a self-closing `<tool name="..." ...attrs.../>` (generic fallback; no specialised reducers in this slice).
- [ ] Dropped entry types do not appear anywhere in rendered output.
- [ ] `<system-reminder>` and `<command-*>` framing tags stripped from user text; slash-command surfaces as one line.
- [ ] `local-claude.ts` and `ssh-claude.ts` write `.md` siblings after each `.jsonl`.
- [ ] Path migration complete: no `raw/` references remain in `src/`, `package.json`, or anything not explicitly in the historical context (FUTURE.md, HANDOFF.md, archived beans may keep references).
- [ ] Fixture-driven tests in `src/lib/claude/renderer/` covering: title fallback chain, frontmatter extraction, turn marker emission, generic tool fallback, dropped entries, framing-strip.
- [ ] `bun run ingest` against existing m4x claude data produces both `.jsonl` and `.md` siblings, rendered files parse as valid YAML-frontmattered markdown, `bun check` passes.
- [ ] `scripts/measure-tokens.sh` produces a baseline ratio: jsonl tokens vs md tokens (expected modest reduction at this stage, real wins arrive in slices 3 & 4).

## User stories addressed

- User story 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 20, 21, 22, 23, 24


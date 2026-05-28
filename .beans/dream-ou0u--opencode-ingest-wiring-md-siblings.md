---
# dream-ou0u
title: 'OpenCode ingest wiring: .md siblings'
status: completed
type: feature
priority: high
created_at: 2026-05-28T11:46:52Z
updated_at: 2026-05-28T12:35:22Z
parent: dream-sk72
blocked_by:
    - dream-h1up
---

## What to build

Wire the OpenCode renderer (from `dream-h1up`) into ingest so that every OpenCode `.jsonl` written by the splitter gets a `.md` sibling rendered alongside it. End-to-end demoable behaviour: a `local-opencode` or `ssh-opencode` ingest run against the real OpenCode SQLite store produces matched `.jsonl` + `.md` pairs in the data lake, mirroring the existing Claude ingest pattern.

See parent PRD (`dream-sk72`) for the post-pass pattern (read just-written `.jsonl`, render, write `.md` sibling) and the rationale for keeping the splitter single-purpose.

Scope of this slice:

- Extend `src/lib/opencode/pull/splitter.ts`: `splitJsonlToSessionFiles` adds `sessionPaths: string[]` to its returned metrics, listing every `.jsonl` it wrote (in write order).
- Update `src/lib/opencode/pull/splitter.test.ts` to assert on the new `sessionPaths` field.
- Modify `src/ingest/sources/local-opencode.ts`: after `splitJsonlToSessionFiles`, iterate `sessionPaths`, read each `.jsonl`, call `renderOpencodeSession(jsonlText)`, write to `<path>.replace(/\.jsonl$/, '.md')`.
- Modify `src/ingest/sources/ssh-opencode.ts`: same post-pass after the splitter finishes.
- Update or add tests as needed for the two source modules.

## Acceptance criteria

- [x] `splitJsonlToSessionFiles` returns `sessionPaths: string[]` in its metrics, populated with every written session file path.
- [x] Splitter tests cover the new field.
- [x] `local-opencode.ts` writes a `.md` sibling for every `.jsonl` produced by the splitter during a pull. Same mtime-day directory.
- [x] `ssh-opencode.ts` writes a `.md` sibling for every `.jsonl` produced by the splitter during a pull.
- [x] Running a real `local-opencode` pull against `~/.local/share/opencode/opencode.db` against a temporary data dir produces matched `.jsonl` + `.md` pairs with non-empty markdown bodies.
- [x] `bun check` clean.

## User stories addressed

Reference by number from the parent PRD (`dream-sk72`):

- User story 5
- User story 12
- User story 13

## Summary of Changes

Splitter (`src/lib/opencode/pull/splitter.ts`) now records every session file it writes in `SplitterMetrics.sessionPaths: string[]`, pushed on the new-session boundary so write order is preserved across day-bucket changes.

Both opencode ingest sources (`src/ingest/sources/local-opencode.ts`, `ssh-opencode.ts`) consume `sessionPaths` via rest-destructure (`const { sessionPaths, ...metrics } = ...`) and run a post-pass: read the just-written `.jsonl`, call `renderOpencodeSession`, write the `.md` sibling. The rest-destructure keeps `sessionPaths` off the returned metrics, which the orchestrator types as `Record<string, number | string>`. SSH post-pass runs after the `sshExit !== 0` check so a failed remote pull won't leave orphan `.md` files.

Added `#lib/opencode/renderer` to `package.json` imports map (above the `#lib/*` wildcard, mirroring the existing `#lib/claude/renderer` entry).

Verified against the real OpenCode DB (`~/.local/share/opencode/opencode.db`, `since=epoch`): 283 sessions → 283 matched `.jsonl` + `.md` pairs, frontmatter renders correctly (sessionId, cwd, project, startedAt/endedAt, providerID/modelID/agent, renderer='opencode-md@1'). `bun check` clean (247 tests, 0 lint/type/knip warnings). Code review (pr-review-toolkit:code-reviewer): no issues at ≥80 confidence.

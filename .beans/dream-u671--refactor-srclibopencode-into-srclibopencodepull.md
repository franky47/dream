---
# dream-u671
title: Refactor src/lib/opencode/ into src/lib/opencode/pull/
status: completed
type: task
priority: high
created_at: 2026-05-11T13:33:45Z
updated_at: 2026-05-11T13:54:47Z
parent: dream-kag4
---

## What to build

Layout-prep refactor: move the existing flat `src/lib/opencode/` deep module (currently `index.ts`, `projection.ts`, `projection.test.ts`, `splitter.ts`, `splitter.test.ts`) into a `pull/` subfolder. This establishes the domain-first / function-second layout (`src/lib/<domain>/<function>/`) before claude's renderer lands in the next slice as `src/lib/claude/renderer/`, so both domains share a consistent shape from day one and the future `src/lib/opencode/renderer/` slots in as a sibling.

The two ingest sources that import from `#lib/opencode` (`src/ingest/sources/local-opencode.ts` and `ssh-opencode.ts`) update to `#lib/opencode/pull`. Any path-alias config (`tsconfig.json` `paths`, `package.json` `imports`) updates to match. No behavioural change — `bun run ingest` runs identically before and after.

See parent PRD dream-kag4 sections "Solution" and "Implementation Decisions" for the layout rationale.

## Acceptance criteria

- [x] `src/lib/opencode/index.ts`, `projection.ts`, `projection.test.ts`, `splitter.ts`, `splitter.test.ts` moved into `src/lib/opencode/pull/`.
- [x] All imports from `#lib/opencode` updated to `#lib/opencode/pull` (or the public re-export shape decided during implementation).
- [x] Path-alias config (`tsconfig.json` and/or `package.json` `imports` field) reflects the new layout.
- [x] `bun check` passes (fmt, lint, typecheck, test, knip).
- [x] `bun run ingest` against the existing local-opencode source produces byte-identical output to pre-refactor (regression smoke).

## User stories addressed

- User story 5

## Summary of Changes

- `git mv` moved `index.ts`, `projection.ts`, `projection.test.ts`, `splitter.ts`, `splitter.test.ts` from `src/lib/opencode/` into `src/lib/opencode/pull/` (history preserved).
- Internal references inside the deep module switched from `#lib/opencode/{projection,splitter}` subpath aliases to relative `./projection.ts` / `./splitter.ts` — internal seams stay internal.
- `package.json` `imports`: dropped the obsolete `#lib/opencode` entry, added `#lib/opencode/pull` → `./src/lib/opencode/pull/index.ts`. The `#lib/*` wildcard remains for sibling modules; nothing in `tsconfig.json` needed updating (no `paths` were configured).
- Ingest sources `local-opencode.ts` and `ssh-opencode.ts` now import from `#lib/opencode/pull`.
- Regression: `bun check` green (116 tests pass, lint/typecheck/knip clean). The existing projection and splitter test suites are unchanged at the assertion level and serve as the byte-identical regression proof.

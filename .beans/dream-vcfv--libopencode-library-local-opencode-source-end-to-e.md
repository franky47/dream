---
# dream-vcfv
title: '#lib/opencode library + local-opencode source end-to-end'
status: completed
type: feature
priority: high
created_at: 2026-05-11T10:38:48Z
updated_at: 2026-05-11T10:38:48Z
parent: dream-cb8j
---

## What to build

The first tracer-bullet slice of the OpenCode ingest source: a working `bun run ingest` that pulls m4x OpenCode sessions for the last 48 hours into `data/raw/m4x/opencode/<sessionId>.jsonl`, exercising the full per-session flat-jsonl row shape end-to-end against the live local db.

This slice introduces the shared `#lib/opencode` library module that the ssh source (`dream-kogf`) will reuse — the SQL projection and the jsonl-stream-to-files splitter are factored here so the two transports differ only in how they obtain the row stream. The `#lib/*` import alias is added to `package.json` in this slice as a side effect; `src/lib/opencode/` is the first occupant.

See parent `dream-cb8j` for: row shape contract, filter rules (subagent exclusion, since cursor), ordering invariants, module sketch, testing decisions, and the rationale for bundling lib with the first consumer rather than shipping a caller-less lib slice.

## Acceptance criteria

- [x] `package.json` `imports` map gains `"#lib/*": "./src/lib/*.ts"`; existing `#src/*` mapping is unchanged
- [x] `src/lib/opencode/projection.ts` exports a function returning `{ sql, params }` for a given `sinceMs`; the SQL is a single combined SELECT union over `session`/`message`/`part` joined with `project`+`workspace` denormalisation, wraps each row in `json_object(...)`, filters `parent_id IS NULL` and `time_updated > ?`, and orders by `(session_id, time_created, type_rank, id)` with the type-rank tiebreaker per the PRD
- [x] `src/lib/opencode/projection.test.ts` builds a synthetic sqlite db in tmpdir matching the relevant column subset, asserts: row count, session-header-first ordering, type-rank tiebreaker honoured on `time_created` ties, since filter behaviour, subagent (`parent_id IS NOT NULL`) exclusion, project + workspace fields denormalised onto session header, every emitted row parses as valid JSON
- [x] `src/lib/opencode/splitter.ts` exports a function from an async line iterable + `outDir` to `{ sessions_pulled, messages_pulled, parts_pulled, bytes }`; opens a fresh file on each `sessionId` change, closes the previous, tolerates blank/partial trailing lines
- [x] `src/lib/opencode/splitter.test.ts` feeds an in-memory async iterable covering: multiple sessions (boundary detection), single session, empty stream, trailing blank line, partial last line, count accuracy across `type=session|message|part`; reads back the files and asserts full content
- [x] `src/lib/opencode/index.ts` re-exports `projection` and `splitter` so `#lib/opencode` is the canonical import path
- [x] `src/ingest/sources/local-opencode.ts` exports `ingestLocalOpencode({ machine, dbPath })` implementing the `Source` contract with `source: 'opencode'`; opens the db read-only via `bun:sqlite`, runs the projection, streams rows as jsonl into the splitter, returns its metrics. `dbPath` defaults to `~/.local/share/opencode/opencode.db` when omitted
- [x] `src/ingest/sources/local-opencode.test.ts` integration-tests the factory against a synthetic db in tmpdir: asserts `source: 'opencode'` and `machine` pass-through, expected per-session files written, metrics shape, subagent exclusion observed end-to-end
- [x] `src/ingest/main.ts` wires `ingestLocalOpencode({ machine: cfg.machine })` into the sources array
- [x] `bun run check` passes (fmt, lint, typecheck, test, knip — knip must not flag the new lib exports because `local-opencode` is consuming them)
- [x] Manual demo: a real `bun run ingest` on m4x produces files under `data/raw/m4x/opencode/`; spot-check a couple of session files visually for correct row shape; run log shows non-zero `sessions_pulled`/`messages_pulled`/`parts_pulled`

## User stories addressed

From parent `dream-cb8j`: 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29.

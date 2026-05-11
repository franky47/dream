---
# dream-cb8j
title: 'OpenCode source: pull session data from local & remote sqlite dbs'
status: completed
type: epic
priority: high
created_at: 2026-05-11T10:36:00Z
updated_at: 2026-05-11T10:36:00Z
---

## Problem Statement

I do a meaningful share of my coding work in **OpenCode** in addition to Claude Code — on m4x and on remote workstations. OpenCode stores all of its session history in a single sqlite database (`~/.local/share/opencode/opencode.db`, ~1.1 GB on my m4x today, 393 sessions / 9.3k messages / 38k parts) rather than in per-session jsonl files. The Dream ingest phase already pulls Claude Code sessions and Firefox history nightly, but OpenCode activity is invisible to it. Without it, my "consolidated knowledge across all the places I do work" picture has a sizeable hole, and the Morning Brew can't surface anything I did in OpenCode — which on some days is most of what I did.

The shape mismatch is the interesting part: every existing source pulls files. OpenCode is one big sqlite database that may be in use by a running OpenCode process when the ingest runs, that is too large to ship over ssh wholesale every night, and that uses a normalised `session` / `message` / `part` schema where the conversational content lives in JSON blobs spread across three tables.

## Solution

A new `opencode` ingest source that projects the sqlite database into the same per-session-jsonl, claude-vibes file shape every other source produces — `data/raw/<machine>/opencode/<sessionId>.jsonl` — with one flat file per top-level session, heterogeneous type-tagged rows interleaved by event time. Two transports, both already standard in this repo:

- **Local** (`local-opencode`) — opens the db read-only via `bun:sqlite`, runs a single projection query, streams rows into per-session files on disk.
- **SSH** (`ssh-opencode`) — runs the same projection query on the remote via `sqlite3 -readonly … "<sql>"` over ssh, streams the combined jsonl back to stdout, splits into per-session files client-side. No remote disk writes, no `tar` step, no full-db transfer.

The SQL projection and the stream-splitter are factored into a new `src/lib/opencode/` library module (`#lib/opencode` import alias) so the two transports share all the projection logic and differ only in how they obtain the row stream. This is the first occupant of `src/lib/` and sets the pattern for future cross-source library modules.

Per-session files contain flat, type-tagged rows in the spirit of Claude Code jsonls: a `{type:"session", …, project:{…}, workspace:{…}}` header row first, then `{type:"message", …}` and `{type:"part", …}` rows interleaved by `time_created`. Sub-agent (child) sessions are excluded at projection time — the summaries land in the parent thread.

Incremental semantics match the existing claude source: any session whose `time_updated > since` is re-emitted in full. Each run wipes the source's output subtree first, so `data/raw/<machine>/opencode/` is always exactly the current 48-hour slice.

## User Stories

1. As a Dream operator, I want OpenCode sessions from m4x pulled into `data/raw/m4x/opencode/<sessionId>.jsonl`, so my OpenCode work is captured alongside my Claude Code work.
2. As a Dream operator, I want OpenCode sessions from remote hosts pulled via ssh into `data/raw/<host>/opencode/<sessionId>.jsonl`, so any machine I OpenCode on is represented.
3. As a Dream operator, I want each session file to be one flat jsonl with type-tagged rows in the same shape vibe as Claude Code session jsonls, so downstream code that already handles claude can be extended cheaply.
4. As a Dream operator, I want the first row of each file to be a `{type:"session", …}` header carrying project + workspace metadata denormalised onto it, so the file is self-describing without joining against other files.
5. As a Dream operator, I want message-level metadata (role, model, mode, agent, cwd, cost, tokens, finish) preserved on each `{type:"message", …}` row, so token-cost and model-distribution analytics work later.
6. As a Dream operator, I want each part written as its own `{type:"part", …}` row with the part's own `type` (`text`, `tool`, `reasoning`, `step-start`, `step-finish`, `patch`, `file`, …) preserved, so the granular event log survives ingest.
7. As a Dream operator, I want rows ordered by `time_created` within each session, with a session→message→part type-rank tiebreaker, so reconstruction is deterministic and the session header always lands first.
8. As a Dream operator, I want sub-agent sessions (sessions with `parent_id IS NOT NULL`) excluded, so I don't ingest fragmented child transcripts whose summaries are already in the parent thread (matches the claude source's `subagents/` exclusion).
9. As a Dream operator, I want only sessions whose `time_updated` falls within the run's `since` window pulled, so nightly runs do bounded work even though the source db is over a gigabyte.
10. As a Dream operator, I want a touched session re-emitted in full, so each file is a self-contained snapshot of the current state of that session (matches "copy if newer" semantics of the claude source).
11. As a Dream operator, I want the existing per-source wipe-before-pull behaviour to apply, so the on-disk mirror is always exactly the last-48h slice and downstream code never has to filter for staleness.
12. As a Dream operator, I want the source to operate safely against a running OpenCode process, so I can ingest at any time without having to quit OpenCode (read-only open, WAL-aware, single-snapshot SELECT).
13. As a Dream operator, I want the remote pull to do zero writes on the remote filesystem, so the ssh strategy is invisible to the remote machine's state.
14. As a Dream operator, I want the remote pull to never ship the full 1.1 GB db over the wire, so even daily runs over slow links stay cheap — only changed sessions cross the wire as jsonl text.
15. As a Dream operator, I want per-source metrics (`sessions_pulled`, `messages_pulled`, `parts_pulled`, `bytes`) in the run log, so I can audit volume and distinguish "I didn't OpenCode last night" from "OpenCode source failed".
16. As a Dream operator, I want ssh-opencode failures (auth, db missing, sqlite3 not installed, query error) surfaced as tagged errors in the run log without aborting the rest of the run, so a remote outage doesn't cost me m4x data — same isolation policy as ssh-claude.
17. As a Dream operator, I want a `DREAM_REMOTE_OPENCODE_HOSTS` env var (comma-separated, plural from day one) wired into config, so I can add a second remote without touching code (matches `DREAM_REMOTE_CLAUDE_HOSTS`).
18. As a Dream operator, I want the local db path overridable via factory argument (default `~/.local/share/opencode/opencode.db`), so non-standard installs still work and tests can target a synthetic fixture.
19. As a developer, I want all OpenCode-specific projection logic (the SQL, the row shapes, the type-rank tiebreaker, the subagent exclusion, the since filter) extracted into a deep module under `src/lib/opencode/`, so it has exactly one home and both transports import it.
20. As a developer, I want a `#lib/opencode` import alias in `package.json`'s `imports` map (and `#lib/*` more generally), so `src/lib/` becomes the established home for cross-source library modules and future libs slot in without import-path churn.
21. As a developer, I want the stream-splitter (jsonl row stream → per-session files + metrics) extracted as a separate function in the same lib, so the same code splits the local `bun:sqlite` iterator and the ssh stdout stream.
22. As a developer, I want the two source factories (`ingestLocalOpencode`, `ingestSshOpencode`) to be thin compositions over the lib — open the row source, hand the stream to the splitter, return the `Source` — so all the interesting logic is testable without ssh or a real db.
23. As a developer, I want the projection SQL emitted as a single string usable verbatim by both `bun:sqlite` and the `sqlite3` CLI on the remote, so the two transports cannot drift apart.
24. As a developer, I want each row emitted as a `json_object(...)` from sqlite, so the jsonl stream is the same whether sourced locally or remotely and the splitter consumes one shape.
25. As a developer, I want the projection module independently testable against a hand-built synthetic sqlite db, so I never need real session data in tests (per the project's "no real personal user data" rule).
26. As a developer, I want the splitter independently testable with an in-memory line iterator, so its session-boundary detection and metric counting are exercised without sqlite at all.
27. As a developer, I want sources named by transport (`local-opencode.ts`, `ssh-opencode.ts`) with the machine label as a runtime parameter, so the existing project naming convention is preserved.
28. As a developer, I want sibling test files (`projection.test.ts`, `splitter.test.ts`, `local-opencode.test.ts`, `ssh-opencode.test.ts`) following the project's existing co-location convention, so test discovery and refactors stay local.
29. As a developer, I want `bun run check` (fmt, lint, typecheck, test, knip) to pass clean on the new code, so the slice is mergeable without follow-up cleanup.
30. As a developer, I want the prerelease ssh path tested at the same `upstream`-argv seam used by `ssh-claude` (fake argv pointing at a local `cat` or `sqlite3` against a fixture), so the ssh transport has real test coverage without touching a real remote — "shells out" is not an excuse to skip tests (per project memory).

## Implementation Decisions

**New library module — `src/lib/opencode/`** (first occupant of `src/lib/`):

- `projection.ts` — owns the SQL string + a typed contract for the three row kinds (`session`, `message`, `part`). One function takes `{ sinceMs }` and returns `{ sql, params }`. The query unions over `session` (joined to `project` and `workspace` and denormalised onto the row), `message`, and `part` filtered to sessions where `parent_id IS NULL` and `time_updated > ?`. Output is wrapped in `json_object(…)` so the stream is jsonl regardless of how the query runs. `ORDER BY session_id, time_created, type_rank, id` with `type_rank = CASE type WHEN 'session' THEN 0 WHEN 'message' THEN 1 WHEN 'part' THEN 2 END`.
- `splitter.ts` — pure function from an async line iterator + `outDir` to a metrics object. Watches each row's `sessionId` field; on change, closes the previous file handle and opens the next. Counts `sessions_pulled` / `messages_pulled` / `parts_pulled` / `bytes`. Tolerates blank/partial last lines.
- `index.ts` — barrel re-export.

**New import alias** — `package.json` `imports` gains `#lib/*: ./src/lib/*.ts`. The existing `#src/*` stays.

**Modified modules:**

- `src/config.ts` — adds `DREAM_REMOTE_OPENCODE_HOSTS` to the Zod schema (CSV, default empty) and exposes `remoteOpencodeHosts: string[]` on the `Config` type. Test additions mirror the existing `remoteClaudeHosts` coverage.
- `src/ingest/main.ts` — instantiates `ingestLocalOpencode({ machine: cfg.machine, dbPath: <default> })` and `cfg.remoteOpencodeHosts.map((host) => ingestSshOpencode({ host }))`. Pure wiring.
- `.env.example` — adds `DREAM_REMOTE_OPENCODE_HOSTS=` documented placeholder.

**New source modules:**

- `src/ingest/sources/local-opencode.ts` — opens `bun:sqlite` with `{ readonly: true }`, calls the projection, iterates rows, hands the line stream to the splitter, returns the `Source`. Source name: `'opencode'`.
- `src/ingest/sources/ssh-opencode.ts` — `Bun.spawn(['ssh', '-o', 'BatchMode=yes', host, "sqlite3 -readonly ~/.local/share/opencode/opencode.db \"<sql>\""])`, pipes stdout into the splitter as a line iterator, captures stderr, surfaces failure via a tagged error following the `SshSourceFailure` pattern in `ssh-claude.ts`. `Bun.spawn` is used directly (not `Bun.$`) per the `Bun.$ ignores pipefail` project memory.

**Row shape contract** (lives in `src/lib/opencode/projection.ts`):

- Session header: `{ type: 'session', id, sessionId, parentId, timestamp, title, directory, version, project: { id, worktree, vcs, name }, workspace: { id, type, name, branch, directory } }`. Emitted as the first row per session.
- Message: `{ type: 'message', id, sessionId, parentId, timestamp, …spread of message.data fields (role, model, mode, agent, cost, tokens, finish, etc.) }`.
- Part: `{ type: 'part', id, sessionId, messageId, timestamp, …spread of part.data fields including the inner part `type` (`text`/`tool`/`reasoning`/`step-start`/`step-finish`/`patch`/`file`/etc.) }`.

`timestamp` is the row's `time_created` rendered as ISO-8601 UTC. The outer `type` (`session|message|part`) and the inner `data.type` (for parts) are intentionally separate fields — outer drives splitter routing, inner survives downstream as the granular event kind.

**Filter rules** (locked into the SQL):

- `session.parent_id IS NULL` (root sessions only — subagents excluded).
- `session.time_updated > :sinceMs` (incremental cursor).
- Messages and parts pulled only for sessions matching the above (via an `IN (SELECT id FROM session WHERE …)` subquery on `session_id`).

**Tables touched, deliberately:** `session`, `message`, `part`, `project`, `workspace`. **Tables skipped, deliberately:** `todo`, `session_entry`, `event`, `event_sequence`, `permission`, `session_share`, all auth/account tables. (`session_entry` is empty in practice; the rest are out of scope for v1 — see Out of Scope.)

**Concurrency / safety:**

- Local: db opened read-only; sqlite gives a consistent snapshot for the single combined SELECT. A running OpenCode that writes during the query is invisible past the snapshot point.
- SSH: `sqlite3 -readonly` enforces the same invariant on the remote.

**Output layout** — `data/raw/<machine>/opencode/<sessionId>.jsonl`. Flat — no project-level subdirs. The session header carries project/workspace context, so downstream regroups by project from row content if it wants to.

**Metrics surfaced to the run log:** `{ sessions_pulled, messages_pulled, parts_pulled, bytes }`. Wired through the existing `Metrics` shape — no orchestrator changes.

## Testing Decisions

**What makes a good test here:** asserts on the external behaviour of each module's contract, not on its internals. For the projection, that means asserting the _rows produced_ by running the query against a synthetic db — not the SQL string itself. For the splitter, that means asserting the _files written_ and _metrics returned_ — not internal buffer state. For the source factories, that means asserting the `Source` labels and the end-to-end pull output against a synthetic db / fake argv.

**Modules tested (all with sibling `*.test.ts` files):**

1. `src/lib/opencode/projection.test.ts` — hand-builds a small sqlite db in tmpdir matching the OpenCode schema (just the columns the projection reads), seeds it with a handful of sessions / messages / parts including a child session that must be excluded, runs the projection, and asserts: row count, ordering invariants (session header first within its block, type-rank tiebreaker honoured), since filter behaviour, subagent exclusion, project/workspace denormalisation onto the session header, JSON validity of every row.

2. `src/lib/opencode/splitter.test.ts` — feeds the splitter an in-memory async iterable of jsonl strings (no sqlite) covering: multiple sessions (boundary detection on `sessionId` change), single session, empty stream, trailing blank line, partial last line, count accuracy across `type=session|message|part`. Reads back the produced files and asserts their full content.

3. `src/ingest/sources/local-opencode.test.ts` — integration: synthetic db file in tmpdir, factory invoked with overridden `dbPath`, asserts `Source` labels (`source: 'opencode'`, machine passed through), and that `pull({ outDir, since })` produces the expected per-session files and metrics. Mirrors `local-claude.test.ts` structure.

4. `src/ingest/sources/ssh-opencode.test.ts` — same `upstream`-argv seam as `ssh-claude.test.ts`: the factory exposes an internal entry point that accepts a custom `upstream` argv; the test passes argv that runs `sqlite3` locally against the synthetic db (or even `cat` of a pre-rendered jsonl fixture) instead of real ssh. Asserts ok path, error path (non-zero exit → tagged error), and metrics.

**Prior art in the codebase:**

- `src/ingest/sources/local-firefox.test.ts` — synthetic sqlite fixture, smallest-possible schema subset, per-test tmp dir.
- `src/ingest/sources/ssh-claude.test.ts` — fake `upstream` argv pointing at local commands, asserts both success and failure paths.
- `src/ingest/sources/local-claude.test.ts` — per-test tmpdir arrange, sibling test file.
- `src/config.test.ts` — Zod env-parse coverage.

These patterns dictate the new tests' shape; no new test infrastructure is introduced.

## Out of Scope

- **Todos, permissions, sandboxes, share URLs, session entries, events** — present in the schema, not extracted in v1. If downstream wants any of these later, extend the projection.
- **Full-db backup / snapshot** — not the goal; per-session jsonl projection is the only output.
- **Delta-row emission** — the cursor is "whole session re-emitted on any change". No partial / append-only per-session deltas.
- **Cross-session aggregation** — no `sessions.jsonl` index, no per-machine summary file. Each session is one file; that's it.
- **Schema-evolution handling** — if OpenCode renames a column or restructures `data` blobs, the projection breaks loud and is updated. No graceful-degradation layer.
- **OpenCode auth, account, control_account tables** — not consumed.
- **Sub-agent transcripts as first-class** — excluded by design; revisit only if a downstream phase proves it needs them.
- **Windows path support** — default db path is the XDG default (`~/.local/share/opencode/opencode.db`), same on macOS and Linux; Windows is not a target.
- **Performance optimisation** — single combined SELECT is expected to be fast enough at current volumes (sub-second per machine in dev). If it becomes a hotspot, revisit.

## Further Notes

- The opencode db is large (~1.1 GB on m4x) and the local opencode process may have it open. Both transports open it strictly read-only — local via `bun:sqlite` `{ readonly: true }`, remote via `sqlite3 -readonly`. WAL mode is on; `sqlite3` and `bun:sqlite` both participate correctly.
- The ssh strategy explicitly avoids `rsync` of the db file. Rationale: even with block-level deltas, sqlite page rewrites can make the diff much larger than the logical change, and an initial sync of 1.1 GB is not worth paying.
- `sqlite3` CLI is assumed present on every remote that runs OpenCode. If the failure mode becomes "sqlite3 not installed on host X", the `SshSourceFailure` tagged error captures stderr clearly and the operator handles it manually.
- Vertical-slice breakdown will be produced separately via `prd-to-issues`. Likely shape: (1) `#lib/opencode` lib module with projection + splitter and their tests; (2) local-opencode source wired end-to-end; (3) ssh-opencode source wired end-to-end. Each slice is independently demoable.
- Naming uses transport prefixes per project memory: `local-opencode`, `ssh-opencode`. The source label is `'opencode'`. Machine label is a runtime parameter.
- All decisions surfaced during the brainstorm are anchored here; the conversation log is otherwise discarded.

---
# dream-gvmb
title: Ingest a basic remote Hermes session
status: done
type: feature
priority: normal
created_at: 2026-07-20T09:43:09Z
updated_at: 2026-07-20T09:43:09Z
parent: dream-sys9
---

## What to build

Deliver the first complete remote Hermes ingest path described by the parent PRD. A configured host must yield raw JSONL and readable Markdown for a human-led root session with no compaction. The source must join normal Dream runs, route by latest message time, and report useful metrics.

## Acceptance criteria

- [x] `DREAM_REMOTE_HERMES_HOSTS` accepts empty, single-host, and comma-separated host settings, and each host creates one Hermes source.
- [x] The source uses SSH batch mode and a read-only SQLite query against the canonical Hermes state database.
- [x] The query selects human-led root sessions by latest message time within the requested half-open window and excludes cron, webhook, and subagent sources.
- [x] External rows are validated before use, and malformed rows fail with clear source context.
- [x] A selected session produces one JSONL file and one unnumbered Markdown file under its latest-message UTC day, machine, and Hermes source directory.
- [x] Existing snapshots outside the cleared ingest range remain untouched.
- [x] Run metrics include session, message, and byte counts.
- [x] Host configuration and remote requirements are documented with the feature.
- [x] Tests cover configuration, projection, filtering, routing, output files, metrics, and source registration without adding SSH failure tests.
- [x] The project-wide check command passes.

## User stories addressed

- User story 1
- User story 2
- User story 3
- User story 4
- User story 5
- User story 6
- User story 7
- User story 13
- User story 20
- User story 39
- User story 40
- User story 41
- User story 42
- User story 43
- User story 44
- User story 45

## Summary of Changes

Added a remote Hermes source that mirrors the OpenCode SSH pattern:

- `DREAM_REMOTE_HERMES_HOSTS` config (comma-separated, trimmed) registers one
  `ssh-hermes` source per host, host label as the runtime machine name.
- `src/lib/hermes/pull/projection.ts` builds a read-only SQLite projection that
  selects human-led root sessions (no parent; excluding `cron`, `webhook`,
  `subagent`) whose latest message falls in the half-open `[since, until)`
  window, emitting a session header row (carrying `latestMessageTime`) followed
  by its message rows.
- `src/lib/hermes/pull/splitter.ts` streams the JSONL into one file per session
  under `<utcDay(latestMessage)>/<machine>/hermes/`, validating every row with
  Zod and failing with `hermes/<machine>` source context on malformed data.
  Metrics report `sessions_pulled`, `messages_pulled`, and `bytes`.
- `src/lib/hermes/renderer/` renders one unnumbered Markdown sibling per
  session (fallback tool renderer only; bespoke tools are a later bean).
- `src/ingest/sources/ssh-hermes.ts` runs `ssh -o BatchMode=yes <host>` +
  `sqlite3 -readonly`. The default DB path is `$HOME/.hermes/state.db`, emitted
  unquoted so the remote shell expands `$HOME` (a single-quoted `~` would not).

Later sibling beans cover full metadata, compaction, tool rendering, rewound
turns, branches/archived sessions, and memory capture.

---
# dream-gvmb
title: Ingest a basic remote Hermes session
status: todo
type: feature
priority: normal
created_at: 2026-07-20T09:43:09Z
updated_at: 2026-07-20T09:43:09Z
parent: dream-sys9
---

## What to build

Deliver the first complete remote Hermes ingest path described by the parent PRD. A configured host must yield raw JSONL and readable Markdown for a human-led root session with no compaction. The source must join normal Dream runs, route by latest message time, and report useful metrics.

## Acceptance criteria

- [ ] `DREAM_REMOTE_HERMES_HOSTS` accepts empty, single-host, and comma-separated host settings, and each host creates one Hermes source.
- [ ] The source uses SSH batch mode and a read-only SQLite query against the canonical Hermes state database.
- [ ] The query selects human-led root sessions by latest message time within the requested half-open window and excludes cron, webhook, and subagent sources.
- [ ] External rows are validated before use, and malformed rows fail with clear source context.
- [ ] A selected session produces one JSONL file and one unnumbered Markdown file under its latest-message UTC day, machine, and Hermes source directory.
- [ ] Existing snapshots outside the cleared ingest range remain untouched.
- [ ] Run metrics include session, message, and byte counts.
- [ ] Host configuration and remote requirements are documented with the feature.
- [ ] Tests cover configuration, projection, filtering, routing, output files, metrics, and source registration without adding SSH failure tests.
- [ ] The project-wide check command passes.

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


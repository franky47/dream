---
# dream-9csm
title: Echo claude-sessions source via ssh+tar
status: todo
type: feature
priority: normal
created_at: 2026-05-10T12:33:01Z
updated_at: 2026-05-10T12:33:01Z
parent: dream-xh9u
blocked_by:
    - dream-b7nn
---

## What to build

Add a second source — Claude Code session JSONLs from the remote `echo` machine — by ssh-ing in and streaming a tar of the in-window files in a single round-trip.

Sources are added to the orchestrator's source list; no orchestrator changes beyond the registration. The pipeline is exactly the one prototyped in the brainstorm and confirmed portable to macOS Monterey BSD userland (bsdtar 3.5.x + BSD find with `-newermt`).

See parent `dream-xh9u` for the source contract, the run-log shape, and the rationale for ssh+tar over rsync/multi-call.

## Acceptance criteria

- [ ] `src/config.ts` (and `.env.example`) extended with `ECHO_HOST` (Zod-validated, required only when this source is active)
- [ ] `src/ingest/sources/echo-claude-sessions.ts` implements the `Source` contract with `machine: "echo"`, `source: "claude-sessions"`
- [ ] The pull executes a single ssh+tar pipeline: `ssh ${ECHO_HOST} "cd ~/.claude && find projects -name '*.jsonl' -newermt '${since}' -not -path '*/subagents/*' -print0 | tar --null -czf - -T -" | tar -xzf - -C ${outDir}`
- [ ] `since` is formatted as `YYYY-MM-DD HH:MM:SS` (BSD-find compatible)
- [ ] Sub-agent transcripts are excluded
- [ ] Non-zero exit from the ssh or tar invocation throws an `errore`-typed error carrying machine + source labels and the underlying exit code / stderr; the orchestrator catches this and records `status: "error"` in the run log without aborting other sources
- [ ] Returns `{ files_pulled, bytes }` on success (orchestrator adds `duration_ms`)
- [ ] Source is added to the source list in `src/ingest/main.ts`
- [ ] No automated test (integration-only — mocking ssh has no ROI). Manual smoke procedure documented in the slice's commit message: run `bun run ingest`, verify `data/raw/echo/claude-sessions/` populated and `data/raw/_meta/*.json` has the echo entry with `status: "ok"`
- [ ] Smoke-test the failure path: temporarily set `ECHO_HOST=invalid.example`, confirm the run still completes, m4x sources still produce data, and the echo entry in the run log shows `status: "error"` with a useful message
- [ ] `bun run check` passes

## User stories addressed

From parent `dream-xh9u`: 5, 6, 13, 14, 15.

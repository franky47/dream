---
# dream-9csm
title: Echo claude-sessions source via ssh+tar
status: in-progress
type: feature
priority: normal
created_at: 2026-05-10T12:33:01Z
updated_at: 2026-05-10T13:36:04Z
parent: dream-xh9u
blocked_by:
  - dream-b7nn
---

## What to build

Add a second source — Claude Code session JSONLs from the remote `echo` machine — by ssh-ing in and streaming a tar of the in-window files in a single round-trip.

Sources are added to the orchestrator's source list; no orchestrator changes beyond the registration. The pipeline is exactly the one prototyped in the brainstorm and confirmed portable to macOS Monterey BSD userland (bsdtar 3.5.x + BSD find with `-newermt`).

See parent `dream-xh9u` for the source contract, the run-log shape, and the rationale for ssh+tar over rsync/multi-call.

## Acceptance criteria

- [x] `src/config.ts` extended with `DREAM_ECHO_HOST` (Zod-validated, optional). `cfg.echoHost` is `null` when unset, so the source is registered only when configured. `.env.example` content provided to user (sandbox blocks `.env*` writes).
- [x] `src/ingest/sources/ssh-claude-sessions.ts` exports `ingestSshClaudeSessions({machine, host})`, implementing the `Source` contract with the supplied machine label + `source: "claude-sessions"` (wired in `main.ts` with `machine: "echo", host: cfg.echoHost`)
- [x] The pull executes a single ssh+tar pipeline via `Bun.spawn` (manual stream piping, since `Bun.$` does not honour `set -o pipefail`): `ssh -o BatchMode=yes ${host} "cd ~/.claude && find projects -name '*.jsonl' -newermt '${since}' -not -path '*/subagents/*' -print0 | tar --null -czf - -T -" | tar -xzf - -C ${outDir}`
- [x] `since` is formatted as `YYYY-MM-DD HH:MM:SS UTC` (the trailing `UTC` keeps BSD-find's `-newermt` time-zone-correct regardless of the remote host's local time)
- [x] Sub-agent transcripts are excluded (`-not -path '*/subagents/*'`)
- [x] Non-zero exit from the ssh **or** tar invocation throws a tagged `SshSourceFailure` carrying machine + source + host + both exit codes + first 500 chars of joined stderr; orchestrator catches via `.catch` and records `status: "error"` without aborting other sources
- [x] Returns `{ files_pulled, bytes }` on success (counted by walking outDir post-extract; orchestrator adds `duration_ms`)
- [x] Source is added to the source list in `src/ingest/main.ts` only when `DREAM_ECHO_HOST` is set
- [x] Smoke-test the failure path: with `DREAM_ECHO_HOST=invalid.example`, the run completes, m4x source still produces data, and the echo entry in the run log shows `status: "error"` with `ssh: Could not resolve hostname …` in the message. Verified.
- [ ] **Pending user verification:** ok-path smoke test with a real reachable echo host that has a recent session. Run `DREAM_ECHO_HOST=echo bun run ingest`; verify `data/raw/echo/claude-sessions/` populated and `data/raw/_meta/*.json` has the echo entry with `status: "ok"`.
- [x] `bun run check` passes (23 tests across 4 files)

## User stories addressed

From parent `dream-xh9u`: 5, 6, 13, 14, 15.

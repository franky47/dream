---
# dream-9csm
title: Echo claude-sessions source via ssh+tar
status: completed
type: feature
priority: normal
created_at: 2026-05-10T12:33:01Z
updated_at: 2026-05-11T08:53:33Z
parent: dream-xh9u
blocked_by:
  - dream-b7nn
---

## What to build

Add a second source — Claude Code session JSONLs from the remote `echo` machine — by ssh-ing in and streaming a tar of the in-window files in a single round-trip.

Sources are added to the orchestrator's source list; no orchestrator changes beyond the registration. The pipeline is exactly the one prototyped in the brainstorm and confirmed portable to macOS Monterey BSD userland (bsdtar 3.5.x + BSD find with `-newermt`).

See parent `dream-xh9u` for the source contract, the run-log shape, and the rationale for ssh+tar over rsync/multi-call.

## Acceptance criteria

- [x] `src/config.ts` extended with `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS` (comma-separated list of ssh-resolvable hostnames; defaults to empty). `cfg.remoteClaudeSessionsHosts` is `string[]` so any number of remote machines can be configured at once. `.env.example` content provided to user (sandbox blocks `.env*` writes).
- [x] `src/ingest/sources/ssh-claude-sessions.ts` exports `ingestSshClaudeSessions({host})`, implementing the `Source` contract with `machine = host` (the ssh hostname doubles as the on-disk label) + `source: "claude-sessions"`. `main.ts` maps `cfg.remoteClaudeSessionsHosts` into one source per host.
- [x] The pull executes a single ssh+tar pipeline via `Bun.spawn` (manual stream piping, since `Bun.$` does not honour `set -o pipefail`): `ssh -o BatchMode=yes ${host} "cd ~/.claude && find projects -name '*.jsonl' -newermt '${since}' -not -path '*/subagents/*' -print0 | tar --null -czf - -T -" | tar -xzf - -C ${outDir}`
- [x] `since` is formatted as `YYYY-MM-DD HH:MM:SS UTC` (the trailing `UTC` keeps BSD-find's `-newermt` time-zone-correct regardless of the remote host's local time)
- [x] Sub-agent transcripts are excluded (`-not -path '*/subagents/*'`)
- [x] Non-zero exit from the ssh **or** tar invocation throws a tagged `SshSourceFailure` carrying machine + source + host + both exit codes + first 500 chars of joined stderr; orchestrator catches via `.catch` and records `status: "error"` without aborting other sources
- [x] Returns `{ files_pulled, bytes }` on success (counted by walking outDir post-extract; orchestrator adds `duration_ms`)
- [x] Sources are added to the orchestrator's source list in `src/ingest/main.ts` from `cfg.remoteClaudeSessionsHosts` (one source per host)
- [x] Smoke-test the failure path: with `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS=invalid.example,another.bad`, the run completes, m4x source still produces data, and both remote entries in the run log show `status: "error"` with `ssh: Could not resolve hostname …`. Verified.
- [x] **Pending user verification:** ok-path smoke test with a real reachable host that has a recent session. Run `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS=echo bun run ingest`; verify `data/raw/echo/claude-sessions/` populated and `data/raw/_meta/*.json` has the echo entry with `status: "ok"`. Verified by user.
- [x] `bun run check` passes (29 tests across 5 files)
- [x] **Tests added** for `ssh-claude-sessions.ts`: pipeline-level tests on `runSshTarPipeline` exercising real `Bun.spawn` + real local `tar` with a fake upstream (`sh -c` instead of `ssh`). Cases: extract+metrics, empty-tar success, upstream non-zero exit, invalid-gzip tar failure, both-streams-fail stderr capture.

## User stories addressed

From parent `dream-xh9u`: 5, 6, 13, 14, 15.

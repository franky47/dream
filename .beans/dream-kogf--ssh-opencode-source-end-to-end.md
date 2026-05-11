---
# dream-kogf
title: ssh-opencode source end-to-end
status: todo
type: feature
priority: high
created_at: 2026-05-11T10:38:51Z
updated_at: 2026-05-11T10:38:51Z
parent: dream-cb8j
blocked_by:
    - dream-vcfv
---

## What to build

The second tracer-bullet slice of the OpenCode ingest source: a working `bun run ingest` that, when `DREAM_REMOTE_OPENCODE_HOSTS` is configured, pulls OpenCode sessions from each remote host into `data/raw/<host>/opencode/<sessionId>.jsonl` via a single ssh round-trip per host that runs `sqlite3 -readonly` on the remote and streams jsonl back over stdout. No remote disk writes; no full-db transfer.

This slice depends on `dream-vcfv` because it consumes the `#lib/opencode` projection (to build the SQL string the remote `sqlite3` runs) and the splitter (to fan the streamed jsonl into per-session files client-side). The two transports differ only in how they obtain the row stream — the lib is unchanged.

See parent `dream-cb8j` for: ssh-strategy rationale (why `sqlite3 -readonly` over the wire, not rsync), the `Bun.spawn`-on-both-sides pattern dictated by the `Bun.$ ignores pipefail` project memory, and prior art in `ssh-claude.ts` / `ssh-claude.test.ts`.

## Acceptance criteria

- [ ] `src/config.ts` Zod schema gains `DREAM_REMOTE_OPENCODE_HOSTS` (CSV string, default empty); `Config` type gains `remoteOpencodeHosts: string[]`; parsed via the existing `parseList` helper
- [ ] `src/config.test.ts` adds coverage mirroring the existing `remoteClaudeHosts` tests: default empty, single host, comma-separated multiple hosts, surrounding whitespace stripped, empty entries dropped
- [ ] `.env.example` documents `DREAM_REMOTE_OPENCODE_HOSTS=` as an optional CSV
- [ ] `src/ingest/sources/ssh-opencode.ts` exports `ingestSshOpencode({ host })` implementing the `Source` contract with `source: 'opencode'`, machine label = `host`; builds the remote command as `sqlite3 -readonly ~/.local/share/opencode/opencode.db "<sql from #lib/opencode/projection>"`; runs ssh + the splitter using `Bun.spawn` (not `Bun.$`) per the `Bun.$ ignores pipefail` memory; uses `-o BatchMode=yes` to fail fast on auth prompts; captures stderr and surfaces failure via a tagged `SshSourceFailure`-style error
- [ ] The factory exposes an internal seam taking a custom `upstream` argv array (mirroring `ssh-claude.ts`) so tests can substitute the ssh invocation with a local command
- [ ] `src/ingest/sources/ssh-opencode.test.ts` uses the `upstream`-argv seam to point at `sqlite3` running locally against a synthetic db (or a `cat` of a pre-rendered jsonl fixture); asserts: ok path produces expected files + metrics, non-zero ssh exit surfaces as a tagged error with the right shape, stderr is captured into the error message
- [ ] `src/ingest/main.ts` wires `cfg.remoteOpencodeHosts.map((host) => ingestSshOpencode({ host }))` into the sources array
- [ ] `bun run check` passes (fmt, lint, typecheck, test, knip)
- [ ] Manual demo: configure `DREAM_REMOTE_OPENCODE_HOSTS=<one real host>` and run `bun run ingest` end-to-end against a real remote; per-session jsonl files land under `data/raw/<host>/opencode/`; run log entry shows `status: ok` with non-zero counts; alternatively, if no remote is currently OpenCode-active, verify with a synthetic remote db that the path works

## User stories addressed

From parent `dream-cb8j`: 2, 13, 14, 16, 17, 22, 27, 28, 29, 30.

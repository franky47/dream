---
# dream-u6u6
title: Fold Claude memories into the claude-sessions source; rename to claude
status: completed
type: feature
priority: normal
created_at: 2026-05-11T09:25:13Z
updated_at: 2026-05-11T09:32:42Z
parent: dream-xh9u
---

## What to build

Pull Claude Code's per-project auto-memory files in the same source as session JSONLs. Memories live alongside sessions at `~/.claude/projects/<encoded-cwd>/memory/*.md` (flat, includes `MEMORY.md` index) and are part of the same Claude Code data surface — they belong in one source.

Rename `claude-sessions` → `claude` everywhere (source name, file names, symbols, env var). Both transports (local + ssh) extend their existing pull to also grab `memory/*.md`, filtered by mtime against the same `since` window. Old `data/raw/<machine>/claude-sessions/` dirs become orphans (orchestrator wipes per-`(machine, source)` outDir on each run); a `clean:legacy-claude-sessions` npm script handles the one-time cleanup.

## Acceptance criteria

- [x] `src/ingest/sources/local-claude-sessions.{ts,test.ts}` renamed to `local-claude.{ts,test.ts}`; `ingestLocalClaudeSessions` → `ingestLocalClaude`; `SOURCE = 'claude'`
- [x] `src/ingest/sources/ssh-claude-sessions.{ts,test.ts}` renamed to `ssh-claude.{ts,test.ts}`; `ingestSshClaudeSessions` → `ingestSshClaude`; `SOURCE = 'claude'`
- [x] `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS` renamed to `DREAM_REMOTE_CLAUDE_HOSTS`; config field `remoteClaudeSessionsHosts` → `remoteClaudeHosts`; `main.ts` wiring updated
- [x] Local pull scans two patterns under `sourceDir`: `**/*.jsonl` (skip `*/subagents/*`) and `*/memory/*.md` (flat, includes `MEMORY.md`); both filtered by `mtime > since`
- [x] SSH pull uses a single `find` predicate combining both: `\( -name '*.jsonl' -not -path '*/subagents/*' \) -o -path '*/memory/*.md'`, with `-newermt '${since}'` applied to the whole expression
- [x] Pull metrics shape: `{ sessions_pulled, memories_pulled, bytes }` for both transports (split file counts, single bytes total)
- [x] Tests cover: memory pull alongside sessions, MEMORY.md index file included, mtime gating, flat-scope (nested `memory/sub/*.md` excluded), subagent exclusion still applies to sessions only, mixed-payload metric split end-to-end via `runSshTarPipeline`, `buildRemoteCmd` predicate composition
- [x] `package.json` adds `clean:legacy-claude-sessions` script that removes any `data/raw/*/claude-sessions/` directories
- [x] `bun check` passes (89 tests across 6 files)
- [ ] `.env.example` content provided to user (sandbox blocks `.env*` writes)

## Notes

Source contract and run-log shape unchanged from parent `dream-xh9u`. This is a same-shape extension of the existing source, not a new source — folding chosen over a sibling `claude-memory` source because sessions and memories are coupled (memories carry `originSessionId` linking back to sessions).

## Summary of changes

- Renamed source files preserving git history; symbol/source-name/env renames flow through config, wiring, and both transports
- Local source now scans two globs (`**/*.jsonl` then `*/memory/*.md`) with a shared `copyIfFresh` helper that reads stat once, gates on mtime, copies, and tallies bytes — avoids duplicating the mtime check
- SSH source: extracted `buildRemoteCmd` for direct testability; predicate is a single grouped `find` with `-newermt` applied to the whole `\(jsonl\) -o memory.md\)` expression so the time filter doesn't get attached to only one branch; metrics now derived by extension at the post-extract walk (`.jsonl` → sessions, `.md` → memories) so the upstream's tar contents drive the split
- New tests: `buildRemoteCmd` predicate shape, mixed-payload extraction split, local memory pull + flat-scope guard
- Clean script `clean:legacy-claude-sessions` for one-time orphan-dir removal after the source rename

## .env.example update needed (sandbox blocks `.env*` writes)

```diff
-DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS=
+DREAM_REMOTE_CLAUDE_HOSTS=
```

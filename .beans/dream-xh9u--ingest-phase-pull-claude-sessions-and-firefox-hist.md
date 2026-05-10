---
# dream-xh9u
title: 'Ingest phase: pull Claude sessions and Firefox history into data/raw/'
status: todo
type: epic
priority: high
created_at: 2026-05-10T12:08:32Z
updated_at: 2026-05-10T12:08:32Z
---

## Problem Statement

Each day I generate knowledge across multiple devices and tools — Claude Code sessions on this machine (m4x) and on a remote workstation (echo), and Firefox browsing history on m4x. That activity is scattered across machines, formats, and append-only logs that nobody reads. The "Dreaming" process aims to consolidate that knowledge nightly into something queryable, linkable in Obsidian, and surfaceable in a Morning Brew. Before any consolidation, enrichment, or digestion can happen, the raw artefacts need to land in one place on a predictable cadence — and they currently don't. The previous prototype (`prototype-py/`) read Claude sessions in-place from `~/.claude/projects/` on a single machine, with no notion of remote pulls, browsing history, or repeatable ingestion runs.

## Solution

A nightly **ingest** phase, scheduled by Taskmaster, that pulls all configured raw data into `data/raw/{machine}/{source}/` on m4x. Each "source" is a self-contained module that knows its labels (machine + source name) and pulls its slice in the simplest way available — local fs copy for m4x sessions, ssh+tar pipeline for echo sessions, `bun:sqlite` read for Firefox. An orchestrator wipes each source's subtree before pulling, runs sources in parallel, catches per-source errors so one failure can't abort the run, and writes a structured run log to `data/raw/_meta/YYYY-MM-DD.json` that downstream phases can ingest as data in its own right. Ingest is intentionally dumb: pure data copy with no LLM calls, no caching, no deduplication. Caching, summarisation, and dedup belong to the enrichment phase that follows.

## User Stories

1. As a Dream operator, I want a single command (`bun run ingest`) that pulls all configured raw data into `data/raw/`, so Taskmaster has one entry point to schedule nightly.
2. As a Dream operator, I want each nightly run to pull the **last 48 hours** of activity, so a missed Taskmaster night (laptop closed, ssh flake) is recovered automatically on the next successful run.
3. As a Dream operator, I want the ingest window passed as an absolute `since: Date` (not a relative duration), so the orchestrator owns the policy and individual sources stay agnostic — and so I can backfill a specific date range later without touching source code.
4. As a Dream operator, I want Claude Code session JSONLs from m4x copied into `data/raw/m4x/claude-sessions/<encoded-cwd>/<sessionId>.jsonl`, so the on-disk shape mirrors the source layout and is trivial to glob.
5. As a Dream operator, I want Claude Code session JSONLs from echo pulled via a single `ssh echo "find … -newermt … | tar"` round-trip into `data/raw/echo/claude-sessions/...`, so network overhead is one connection regardless of file count.
6. As a Dream operator, I want sub-agent transcripts (`**/subagents/**`) excluded from both machines, so I don't ingest nested runs that aren't first-class sessions.
7. As a Dream operator, I want Firefox browsing history exported from m4x's `places.sqlite` into `data/raw/m4x/firefox/YYYY-MM-DD.csv`, so URLs and titles are captured for later enrichment.
8. As a privacy-conscious Dream operator, I want a domain blocklist (e.g. news, social) applied **before** Firefox URLs hit disk, so high-volume noise never enters the pipeline. Smart, per-URL sensitive-content filtering happens later via local model in the enrichment phase.
9. As a Dream operator, I want the Firefox source to lock-safely snapshot `places.sqlite` + `places.sqlite-wal` to a tmp dir before querying, so a running Firefox instance doesn't corrupt the read.
10. As a Dream operator, I want the orchestrator to **wipe each source's subtree before pulling**, so the on-disk mirror is always exactly the last-48h slice and downstream code never has to filter for staleness.
11. As a Dream operator, I want each source's wipe handled by the orchestrator from the source's declared labels, so individual source modules don't repeat boilerplate.
12. As a Dream operator, I want sources to run in parallel via `Promise.allSettled`, so total wall time is bounded by the slowest source rather than the sum.
13. As a Dream operator, I want one source's failure to be **logged and skipped, not aborted**, so a flaky echo doesn't cost me my m4x and Firefox data for the night.
14. As a Dream operator, I want a structured run log written to `data/raw/_meta/YYYY-MM-DD.json` capturing per-source `status`, `duration_ms`, and source-specific metrics (`files_pulled`, `bytes`, `rows`, `blocklist_filtered`), so I can audit what happened and so the digest phase can surface "echo unreachable last night" in the Morning Brew.
15. As a Dream operator, I want the run log to distinguish **connection status** (ok/error) from **data quantity** (rows/files pulled), so "echo up but I didn't work on it" looks different from "echo unreachable".
16. As a developer, I want each source implemented in the simplest way for its case, with no shared transport or `Machine` abstraction, so the code stays inspectable and adding a new source means writing one new file with the simplest possible impl.
17. As a developer, I want the `Source` contract to be `{ machine: string, source: string, pull({ outDir, since }): Promise<Metrics> }`, so the orchestrator can wipe the right directory, time the call, catch errors, and build the log entry from the labels — without sources owning any of that.
18. As a developer, I want all environment configuration (`DREAM_DATA_DIR`, `DREAM_MACHINE`, `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS`, `FIREFOX_PROFILE`) loaded from `.env` (Bun auto-loads) and validated by a Zod schema at startup, so misconfiguration fails loud immediately rather than mid-pull.
19. As a developer, I want test files as siblings of the modules they test (e.g. `local-firefox.ts` + `local-firefox.test.ts`), so test discovery is local to the module and refactors move tests with code.
20. As a developer, I want each test to arrange its own fixtures (e.g. create a tiny tmp `places.sqlite` with only the rows that case needs), so failing tests are self-explanatory and there's no shared fixture coupling.
21. As a developer, I want types exported from the module that defines them (not a central `types.ts`), so changes are localised.
22. As a developer, I want Taskmaster to invoke the ingest as a single command and treat any non-zero exit as catastrophic only — per-source failures are first-class log content, not exit codes.

## Implementation Decisions

**Architecture**

- Pull topology: orchestrator runs on m4x, reaches out to echo via ssh. No push-from-echo, no per-machine scheduling.
- The on-disk layout is **machine-first**: `data/raw/{machine}/{source}/...`. Adding a machine = `mkdir`; wiping a machine = `rm -rf data/raw/{machine}`.
- Source matrix v1: `m4x × {claude-sessions, firefox}`, `echo × {claude-sessions}`. No browser data on echo.

**Source contract**

- `Source = { machine: string; source: string; pull(opts: { outDir: string; since: Date }): Promise<Metrics> }`.
- Sources receive their `outDir` and the absolute `since` cutoff; they don't compute either.
- Sources have no shared transport — each does the simplest thing. Local fs uses `cp`/glob, echo uses ssh+tar, Firefox uses `bun:sqlite`. No `Machine` class.
- `Metrics` is source-specific (extra fields permitted) but always includes the fields the run log needs.
- Sources signal failure by **throwing**. The orchestrator catches and converts to a log entry. We use the `errore` library for typed errors so failures carry structured context (source, machine, underlying cause) into the log.

**Orchestrator**

- Iterates the source list once. For each source: derive `outDir` from `data/raw/{machine}/{source}/`, wipe + recreate, then `await pull(...)`. Wipe handled centrally so source modules don't repeat the dance.
- Runs all sources concurrently via `Promise.allSettled` and collects results in source-list order.
- Times each source (`duration_ms`) regardless of outcome.
- Writes the run log last; never throws to the CLI unless something catastrophic happens (e.g. cannot create `_meta/`).

**ssh+tar specifics (echo claude-sessions)**

- Single-round-trip pipeline (per remote host): `ssh ${host} "cd ~/.claude && find projects -name '*.jsonl' -newermt '${since}' -not -path '*/subagents/*' -print0 | tar --null -czf - -T -" | tar -xzf - -C ${outDir}`.
- `since` formatted as `YYYY-MM-DD HH:MM:SS` (BSD-find-compatible).
- Verified portable to macOS Monterey BSD userland (bsdtar 3.5.x supports `--null` + `-T -`; BSD find supports `-newermt`).

**Firefox source specifics**

- Lock-safe snapshot: copy `${FIREFOX_PROFILE}/places.sqlite` and `places.sqlite-wal` to a tmp dir before querying.
- Query: `last_visit_date > strftime('%s', $since) * 1000000`, `GROUP BY url`, drop query strings and fragments (preserve canonical URL).
- Domain blocklist: read `config/firefox-blocklist.txt` (one domain per line, `#` comments allowed), filter rows by domain match before write. Record `blocklist_filtered` count in metrics.
- Output csv columns: `visited`, `url`, `title`. One file per run named by run date.

**m4x claude-sessions specifics**

- Bun glob `~/.claude/projects/**/*.jsonl`, filter by mtime > `since`, exclude `**/subagents/**`.
- Copy each match preserving the relative path under `outDir`, so the output mirror is structurally identical to the source layout.

**Run log**

- Path: `data/raw/_meta/YYYY-MM-DD.json` (the run's local-date).
- Schema: `{ run_started_at, run_finished_at, sources: [{ machine, source, status, duration_ms, ...metrics | error }] }`.
- Validated by Zod; serialised pretty-printed for human readability and diff-ability.
- The log is itself raw data — the digest phase will read `_meta/*.json` and turn ops failures into Morning-Brew-visible content.

**Caching**

- **Ingest has no cache.** The 48h overlap between consecutive runs re-copies the same source files; this is intentional and cheap. Caching belongs to enrichment, keyed on `sha256(sessionId + prompt_version + content)` for sessions and `url` for Firefox. Ingest is pure data transport.

**Configuration**

- `.env` loaded by Bun (no dotenv). Validated by a Zod schema in `src/config.ts`; invalid env throws at startup.
- Required: `DREAM_DATA_DIR`. `FIREFOX_PROFILE` is required only when the firefox source is enabled.
- Optional: `DREAM_MACHINE` — label written into `data/raw/{machine}/...` for sources running on the local box. Defaults to `local` so the tool works out of the box; set to e.g. `m4x` when the on-disk layout should reflect the actual host name.
- Optional: `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS` — comma-separated list of ssh-resolvable hostnames (typically aliases from `~/.ssh/config`). Each entry registers an `ingestSshClaudeSessions({host})` source; the host string is used both as the ssh target and the on-disk machine label. Empty (default) means no remote sources.
- The Firefox blocklist lives at `config/firefox-blocklist.txt` (plain text, user-editable, version-controlled).

**Error handling**

- `errore` for typed, contextual errors throughout the ingest phase. Each source error carries source/machine labels so the orchestrator can build a meaningful log entry without re-parsing strings.

**Module sketch**

- `src/config.ts` — Zod env schema + parse, exports validated config.
- `src/ingest/orchestrator.ts` — exports `run()` and the `Source`/`SourceResult` types it owns.
- `src/ingest/log.ts` — pure: takes `Array<SourceResult>` + run window, returns/writes the structured JSON. Exports `RunLog` type if needed.
- `src/ingest/main.ts` — `bun run ingest` entry; thin wrapper over `orchestrator.run()`.
- `src/ingest/sources/local-claude-sessions.ts` — local glob + copy. Factory `ingestLocalClaudeSessions({machine, sourceDir})`; machine label is supplied by the caller so the same module can be used wherever the orchestrator runs.
- `src/ingest/sources/ssh-claude-sessions.ts` — ssh+tar pipeline via `Bun.spawn` (manual stream piping; `Bun.$` does not honour `set -o pipefail`, so a failing ssh in a pipeline returns 0). Factory `ingestSshClaudeSessions({host})`; the host string doubles as the on-disk machine label, so re-using the source for a different machine is a one-line change to `DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS`.
- `src/ingest/sources/local-firefox.ts` — `bun:sqlite` + blocklist + csv emit. Factory `ingestLocalFirefox({machine, profileDir})`.

Source files are named by **transport** (`local-`, `ssh-`), not by machine. The machine label is a runtime input passed in by `main.ts` — currently `m4x` for local sources, `echo` for the ssh source.

**Out of band**

- Lint/format via `oxlint` + `oxfmt` configured at the repo level; no behavioural surface, doesn't influence ingest design.

## Testing Decisions

**What makes a good test here**

- Tests assert **external behaviour visible to the next phase** (files written, metrics returned, log shape) — not internal control flow.
- Each test arranges its own fixtures inline (a tmp dir, a handcrafted sqlite, a 2-line blocklist), acts on the module under test, asserts on the side-effects. No shared `tests/fixtures/` directory.
- Tests live as siblings of the code they test (e.g. `local-firefox.ts` + `local-firefox.test.ts`).

**Modules with tests**

- **`src/ingest/log.ts`** — pure function, easy to cover exhaustively. Cases: all-ok, mixed-ok-and-error, all-error, zero sources, ISO timestamp formatting, Zod schema acceptance.
- **`src/ingest/orchestrator.ts`** — using fake Source objects. Cases: wipe occurred before pull (pre-existing file in outDir is gone after run); partial failure (one source throws, others still run, log captures all three); duration is recorded even on throw; concurrent execution (two slow sources have wall-time ≈ max not sum).
- **`src/ingest/sources/local-firefox.ts`** — arrange-per-test pattern. Each test creates a tmp `places.sqlite` via `bun:sqlite` with only the rows under test (in-window vs out-of-window, blocklisted vs not, duplicate URLs collapsed) plus a tiny blocklist file, calls `pull(...)`, asserts the emitted csv rows + `blocklist_filtered` count. Lock-safe copy is exercised by the module pulling against a sqlite that's currently open in the test process.
- **`src/config.ts`** — Zod validation: missing required env throws, valid env returns parsed config.

**Modules without tests**

- `src/ingest/sources/local-claude-sessions.ts` — almost entirely fs glob + copy. If a smoke test is added, it'd just exercise `Bun.Glob`. Skipped unless a specific bug motivates one.
- `src/ingest/sources/ssh-claude-sessions.ts` — integration-only (real ssh, real remote fs). Mocking ssh has low ROI. Manual smoke test as part of the rollout.
- `src/ingest/main.ts` — wiring only.

**Prior art** — none in this repo yet; this is the first TypeScript module. The Python prototype in `prototype-py/` is not a reference for test patterns.

## Out of Scope

- **All enrichment**: LLM summarisation, learning extraction, prompt-version cache, model-tier policy by `turns`, title generation fallback for sessions without `ai-title`. Ingest produces raw bytes; enrichment turns them into structured records.
- **Privacy filtering of URL content** (i.e. "should this URL be in the dataset based on its content"). Only a coarse domain blocklist runs at ingest. Smart filtering is an enrichment-phase local-model pass.
- **Deduplication across sessions or runs.** Ingest accepts overlap; downstream phases handle dedup.
- **Persistence to a queryable store** (sqlite via `bun:sqlite`, etc.). Ingest writes flat files; the queryable store is a downstream concern.
- **Other sources**: Obsidian git diffs, terminal history, tweets, Slack export, etc. Architecture supports adding them as new source modules; v1 ships the three above only.
- **Browsing history from echo** (no browser usage there).
- **Backfill mode / arbitrary date ranges.** The `since: Date` contract supports it trivially, but no CLI surface for it in v1; deferred until needed.
- **Dev tooling** (`oxlint`, `oxfmt`): configured separately; not part of this epic.

## Further Notes

- Idempotency comes from the wipe-then-pull discipline plus deterministic on-disk paths derived from source-side names (encoded cwd, sessionId, run date). Re-running ingest within the same window produces an equivalent tree.
- The 48h window is a safety margin around the nightly cadence, not a feature. If Taskmaster ever runs ingest at a different cadence, the window should be revisited (rule of thumb: ≥ 2× scheduled interval).
- The Python prototype (`prototype-py/`) and `data/sessions_meta.json`, `data/sub_agent_baseline.json`, etc. remain untouched. They informed the enrichment-phase decisions (prompt v5, model comparison) but are not consumed by ingest.
- The blocklist file format is intentionally plain text rather than a sqlite/JSON schema: easy to edit, easy to diff in PRs, friction-free to extend.

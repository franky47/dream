---
# dream-sys9
title: Add remote Hermes session and memory ingestion
status: done
type: epic
priority: normal
created_at: 2026-07-20T09:37:50Z
updated_at: 2026-07-20T14:30:00Z
---

## Problem Statement

Dream cannot ingest Hermes Agent sessions or memories from a remote machine. Hermes keeps its current session data in a live SQLite database rather than one JSONL file per session. That database also mixes human conversations with cron runs, webhook jobs, subagents, user branches, archived sessions, rewound turns, and more than one form of context compaction.

Hermes stores knowledge learned across sessions in built-in Markdown memory files. Leaving those files behind would omit some of the most useful knowledge extracted from the sessions that Dream collects.

A plain database copy would not fit Dream's source layout or its readable Markdown format. It could also lose the shape of each context window, expose Hermes control text, or present stale and rewound messages as active conversation. The user needs a read-only source that preserves the full raw record, captures learned memory, and produces Markdown that remains useful to people and agents.

## Solution

Add a remote Hermes source that reads each configured host through SSH and queries the Hermes session database in read-only mode. It will ingest human-led sessions, including user branches and archived sessions, while excluding background work such as cron, webhook, and subagent runs.

The same source will copy Hermes' built-in agent memory and user-profile memory as exact Markdown files. Each memory file will follow Dream's existing memory convention and use its own modification time for incremental selection and UTC day routing.

The source will write one raw JSONL record per logical session. It will preserve complete session and message data, including platform IDs, system prompts, model settings, reasoning, compacted rows, and rewound rows. Rotated continuation sessions will join their root as one logical session without losing their physical session IDs.

The source will also render readable Markdown. Sessions with no compaction will have one Markdown file. Sessions with compaction will have one numbered file per context window. Each later window will begin with a compacted summary and retain the recent tail that Hermes sent to the model. Earlier windows will link to the next window.

All artifacts for a session snapshot will live under the UTC date of its latest message. Existing copies in older date buckets will remain as past snapshots.

## User Stories

1. As a Dream user, I want to configure one or more remote Hermes hosts, so that I can ingest Hermes sessions from every machine I use.
2. As a Dream user, I want the source to use my existing SSH setup, so that I do not need a new remote service or credential flow.
3. As a Dream user, I want remote access to remain read-only, so that ingestion cannot alter a live Hermes session database.
4. As a Dream user, I want each host to appear as its own machine in Dream's data layout, so that I can tell where a session ran.
5. As a Dream user, I want human-led Hermes sessions included, so that my chats and coding work become part of my archive.
6. As a Dream user, I want sessions from current and future human messaging platforms included, so that the source does not depend on a fixed Discord and CLI list.
7. As a Dream user, I want cron, webhook, and subagent runs excluded, so that background work does not crowd the human session archive.
8. As a Dream user, I want user-created branches included as separate sessions, so that deliberate branches remain visible.
9. As a Dream user, I want archived Hermes sessions included, so that hiding a session in Hermes does not remove it from Dream.
10. As a Dream user, I want archived Markdown marked with `archived: true`, so that I can identify archived sessions without opening raw data.
11. As a Dream user, I want rotated continuation sessions joined to their logical root, so that one conversation does not appear as unrelated UUIDs.
12. As a Dream user, I want every physical session ID retained in raw data, so that joined conversations remain traceable to Hermes.
13. As a Dream user, I want one raw JSONL file per logical session, so that the source follows Dream's existing source format.
14. As a Dream user, I want raw JSONL to retain all session metadata, so that future tools can use fields the first Markdown renderer does not show.
15. As a Dream user, I want system prompts and model settings kept in JSONL, so that the raw archive remains complete.
16. As a Dream user, I want reasoning fields kept in JSONL but hidden from Markdown, so that the archive keeps source data without making the readable view noisy.
17. As a Dream user, I want rewound turns kept in JSONL, so that the raw archive retains Hermes' audit record.
18. As a Dream user, I want rewound turns omitted from Markdown, so that withdrawn work does not look like part of the live conversation.
19. As a Dream user, I want compacted source rows retained in JSONL, so that no history is lost when Hermes shortens its live context.
20. As a Dream user, I want a session with no compaction rendered as one Markdown file, so that simple sessions keep simple names.
21. As a Dream user, I want a compacted session split into numbered context-window files, so that I can inspect what the model saw at each stage.
22. As a Dream user, I want the number of Markdown files to equal the number of compactions plus one, so that every context window has one file.
23. As a Dream user, I want each numbered fragment to include full frontmatter, so that each file works on its own.
24. As a Dream user, I want fragment time and usage fields to describe that fragment, so that its metadata matches its contents.
25. As a Dream user, I want each numbered fragment to state its context-window number, so that tools can order the files without parsing names.
26. As a Dream user, I want each non-final fragment to name the next context window in frontmatter, so that tools can follow the chain.
27. As a Dream user, I want each non-final fragment to end with a relative Markdown link, so that people and agents can continue to the next window.
28. As a Dream user, I want each new context window to begin with the summary Hermes sent to the model, so that the transition remains clear.
29. As a Dream user, I want compaction summaries wrapped in a compact `<compaction>` block, so that people and agents can spot the boundary.
30. As a Dream user, I want Hermes' long compaction safety prefix and end marker removed from Markdown, so that the block shows the useful summary body.
31. As a Dream user, I want a compaction block to retain its turn number, role, and relative time, so that it remains part of the rendered exchange.
32. As a Dream user, I want each new context window to repeat Hermes' preserved recent tail, so that the file matches the context sent to the model.
33. As a Dream user, I want historical and merged compaction forms recognized, so that old sessions render like new sessions.
34. As a Dream user, I want Discord trigger-message control notes removed from Markdown, so that internal tool guidance does not obscure my message.
35. As a Dream user, I want sender, reply, and attachment notes kept in Markdown, so that useful platform context remains visible.
36. As a Dream user, I want all platform IDs available in Markdown frontmatter, so that I can trace a rendered session back to its platform channel and thread.
37. As a Dream user, I want Hermes tools rendered in their own source style, so that terminal, file, patch, search, todo, and clarify calls stay concise and useful.
38. As a Dream user, I want unknown Hermes tools to use the standard compact fallback, so that new tools do not break rendering.
39. As a Dream user, I want each session snapshot filed under the UTC day of its latest message, so that multi-day sessions stay together.
40. As a Dream user, I want every Markdown fragment and its JSONL file stored under the same day, so that a session snapshot is easy to find.
41. As a Dream user, I want older dated copies left in place, so that prior snapshots remain available after a session resumes on a later day.
42. As a Dream user, I want session selection based on latest message time, so that changed sessions get pulled during incremental ingestion.
43. As a Dream user, I want the Hermes source to report useful counts and byte totals, so that ingest run logs show what changed.
44. As a Dream user, I want malformed external rows rejected with clear source errors, so that bad remote data does not produce misleading files.
45. As a Dream user, I want Hermes ingestion to run with the other sources, so that one Dream command refreshes the full archive.
46. As a Dream user, I want Hermes' agent memory captured, so that durable lessons learned across sessions become part of Dream.
47. As a Dream user, I want Hermes' user-profile memory captured, so that learned preferences and personal context are not lost.
48. As a Dream user, I want memory files copied without rewriting their Markdown, so that Dream preserves the source knowledge exactly.
49. As a Dream user, I want each changed memory filed under its own modification date, so that incremental ingestion follows the same rule as other memory sources.
50. As a Dream user, I want missing optional memory files to be harmless, so that a new Hermes install can still ingest sessions.
51. As a Dream user, I want memory counts included in ingest metrics, so that run logs show when learned knowledge changed.

## Implementation Decisions

- Add a remote-only Hermes source. A local Hermes source is not part of this work.
- Capture the built-in `MEMORY.md` and `USER.md` files from each configured Hermes home.
- Copy memory Markdown exactly under the Hermes source's `memories` area. Do not generate sibling files or rewrite content.
- Exclude lock files and other files in the memory directory.
- Select each memory file by its own modification time within the requested half-open window and route it to that modification time's UTC day.
- Treat both memory files as optional and report copied files through `memories_pulled` and byte metrics.
- Configure hosts through `DREAM_REMOTE_HERMES_HOSTS` as a comma-separated list, following the existing remote-source pattern.
- Use SSH batch mode and the remote SQLite command-line client to run a read-only query against the canonical Hermes state database.
- Keep SSH transport separate from transcript processing and Markdown rendering.
- Put database row validation, logical-session grouping, continuation-chain handling, and context-window discovery behind one transcript interface.
- Parse all remote and JSON data with Zod before using it.
- Treat sessions from human platforms as eligible by default. Exclude known background sources such as cron, webhook, and subagent.
- Include user-created branch sessions according to Hermes' own list rules.
- Include archived sessions and emit `archived: true` only when a session is archived.
- Join rotated compaction continuations under the root logical session while retaining each physical session ID in JSONL.
- Select sessions by latest message time within the requested half-open ingest window.
- Route a complete session snapshot, including every Markdown fragment, to the UTC day of its latest message.
- Do not remove older snapshots from earlier day buckets.
- Write one source-specific JSONL file per logical session.
- Preserve complete session metadata in JSONL, including platform identity, system prompt, model configuration, archive state, lineage, and usage fields.
- Preserve complete message metadata in JSONL, including reasoning, tool data, activity state, compaction state, and fields needed to trace source rows.
- Keep rewound rows in JSONL and omit them from Markdown.
- Keep reasoning in JSONL and omit it from Markdown.
- Render one unnumbered Markdown file when no compaction occurred.
- Render one numbered Markdown file per context window when compaction occurred. The number of files is the number of compactions plus one.
- Repeat the tail that Hermes preserved after compaction so that each fragment reflects the real model context.
- Give each numbered fragment full frontmatter. Time bounds, turn counts, and tool counts describe that fragment.
- Add `contextWindow` to every numbered fragment. Add `nextContextWindow` to every numbered fragment except the last.
- End each non-final fragment with a relative Markdown link to the next fragment.
- Render a compaction summary as a single `<compaction>` element with turn number, stored role, and relative time attributes.
- Strip known Hermes compaction instructions and end markers while retaining the summary body.
- Recognize current, historical, and merged compaction markers.
- Strip only the Discord triggering-message ID note from user text. Retain sender, reply, attachment, and other useful context.
- Include all available platform IDs in Markdown frontmatter.
- Give Hermes a source-specific tool renderer. Parse known Hermes tool inputs and results according to their own shapes. Use the standard compact fallback for unknown tools.
- Keep Markdown syntax practical rather than rigid. Readability and simple code take priority over a formal document schema.
- Follow existing source behavior for orchestration, metrics, day buckets, run logs, and source-level error reporting.

## Testing Decisions

- Tests will assert public behavior through projected rows, produced files, rendered content, and reported metrics. They will not target private helpers.
- Config tests will cover absent, empty, single-host, multi-host, and whitespace-trimmed Hermes host settings.
- Source registration tests will confirm that each configured host creates one Hermes source.
- Projection tests will use a small Hermes-shaped SQLite fixture and cover the requested time window.
- Session-selection tests will cover human platforms, excluded background sources, user branches, archived sessions, and rotated continuation chains.
- Transcript tests will cover logical-session grouping, physical ID retention, raw metadata, compaction rows, and rewound rows.
- Context-window tests will cover no compaction, one compaction, several compactions, repeated tails, historical summary prefixes, and merged summaries.
- Routing tests will confirm that all artifacts use the latest message's UTC day and that old day snapshots remain untouched.
- Markdown tests will cover unnumbered and numbered names, per-window frontmatter, archive flags, next-window fields, relative links, compaction blocks, and per-window counts.
- Message-cleanup tests will cover reasoning omission, rewound-message omission, Discord trigger-note removal, and retention of sender, reply, and attachment context.
- Tool-renderer tests will cover each supported Hermes tool shape and the unknown-tool fallback.
- Memory tests will cover both built-in files, exact byte preservation, modification-time filtering, UTC day routing, missing files, lock-file exclusion, counts, and bytes.
- The closest prior work is the existing OpenCode database projection and splitter tests, remote Claude memory transfer tests, local Codex memory tests, and source-specific Markdown renderer tests.
- SSH failure handling will not receive feature-specific tests in this work.
- The project-wide check command must pass before the work is complete.

## Out of Scope

- A local Hermes source.
- Copying Hermes skills, cache files, logs, or other home-directory data beyond the two built-in memory files.
- Exporting data from optional external Hermes memory providers.
- Ingesting cron, webhook, or subagent sessions.
- Changing Hermes or writing to its database.
- Provisioning SSH keys, host aliases, known-host entries, or the remote SQLite client.
- Removing older session snapshots from prior day buckets.
- Adding context-window fragments to Claude, Codex, Pi, or OpenCode. The idea may be handled later.
- Adding a user interface, search index, or consolidation database.
- Defining a strict public schema for the human-readable Markdown markup.
- Feature-specific tests for SSH connection and process failures.

## Further Notes

Research on the Echo host confirmed that the SQLite state database is the canonical Hermes transcript store. The older sessions JSON file now serves as a routing mirror and does not contain full transcripts.

Echo currently stores built-in memory in `MEMORY.md` and `USER.md` alongside empty lock files. The Markdown files are independent mutable snapshots, so they follow their own modification times rather than a session's latest-message date.

Hermes compaction does not persist a dedicated event flag. It archives prior rows, inserts a new live context, and identifies the summary through stable content markers. The source must derive context windows from those rows and markers.

The first configured deployment target is `echo`, but the source must remain host-neutral.

### Reconciled against live Echo schema

The vertical was first built against a guessed schema, then reconciled with the real Echo `sessions`/`messages` DDL and data samples:

- Sessions key platform identity in discrete columns (`user_id`, `session_key`, `chat_id`, `chat_type`, `thread_id`, `display_name`) plus a rich `origin_json` blob; the projection merges both into one `platform` object via `json_patch`. Usage lives in discrete token columns, gathered into a `usage` object. Real columns: `parent_session_id`, `started_at`/`ended_at` (REAL epoch seconds, ×1000 to ms), `model_config`. There is no `platform`/`usage`/`created_at`/`model_settings` column.
- Messages carry nullable `content`, an OpenAI-shaped `tool_calls` JSON array on assistant rows, and `role='tool'` result rows keyed by `tool_call_id`; arguments are a JSON string. There is no `turn` or `metadata` column. `session_meta` rows (empty content) stay in JSONL but are excluded from Markdown.
- Flag matrix: compaction archives rows as `active=0, compacted=1` (kept in earlier windows); a `/undo` is `active=0, compacted=0` (the only genuine rewind, dropped from Markdown).
- The compaction summary is a live (`active=1`) user row whose content starts with `[CONTEXT COMPACTION — REFERENCE ONLY]`; cleaning strips through `avoid repeating it:` and the `--- END OF CONTEXT SUMMARY … ---` marker. The invented `[hermes:compaction-summary]` bracket markers and their historical/merged variants did not exist and were removed.
- Discord user rows are framed only by a `[Triggering message id: … discord tools.]` line (stripped); the `[Name]` sender prefix is kept.
- Bespoke tool renderers were reduced to the verified `terminal` (`{command, workdir, timeout}`) and `skill_view` (`{name, file_path}`); the invented read/write/patch/search/todo/clarify renderers were dropped, so unverified tools now use the compact fallback.
- Remote memory directory corrected to `$HOME/.hermes/memories`.

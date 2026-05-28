---
# dream-ou0u
title: 'OpenCode ingest wiring: .md siblings'
status: todo
type: feature
priority: high
created_at: 2026-05-28T11:46:52Z
updated_at: 2026-05-28T11:46:52Z
parent: dream-sk72
blocked_by:
    - dream-h1up
---

## What to build

Wire the OpenCode renderer (from `dream-h1up`) into ingest so that every OpenCode `.jsonl` written by the splitter gets a `.md` sibling rendered alongside it. End-to-end demoable behaviour: a `local-opencode` or `ssh-opencode` ingest run against the real OpenCode SQLite store produces matched `.jsonl` + `.md` pairs in the data lake, mirroring the existing Claude ingest pattern.

See parent PRD (`dream-sk72`) for the post-pass pattern (read just-written `.jsonl`, render, write `.md` sibling) and the rationale for keeping the splitter single-purpose.

Scope of this slice:

- Extend `src/lib/opencode/pull/splitter.ts`: `splitJsonlToSessionFiles` adds `sessionPaths: string[]` to its returned metrics, listing every `.jsonl` it wrote (in write order).
- Update `src/lib/opencode/pull/splitter.test.ts` to assert on the new `sessionPaths` field.
- Modify `src/ingest/sources/local-opencode.ts`: after `splitJsonlToSessionFiles`, iterate `sessionPaths`, read each `.jsonl`, call `renderOpencodeSession(jsonlText)`, write to `<path>.replace(/\.jsonl$/, '.md')`.
- Modify `src/ingest/sources/ssh-opencode.ts`: same post-pass after the splitter finishes.
- Update or add tests as needed for the two source modules.

## Acceptance criteria

- [ ] `splitJsonlToSessionFiles` returns `sessionPaths: string[]` in its metrics, populated with every written session file path.
- [ ] Splitter tests cover the new field.
- [ ] `local-opencode.ts` writes a `.md` sibling for every `.jsonl` produced by the splitter during a pull. Same mtime-day directory.
- [ ] `ssh-opencode.ts` writes a `.md` sibling for every `.jsonl` produced by the splitter during a pull.
- [ ] Running a real `local-opencode` pull against `~/.local/share/opencode/opencode.db` against a temporary data dir produces matched `.jsonl` + `.md` pairs with non-empty markdown bodies.
- [ ] `bun check` clean.

## User stories addressed

Reference by number from the parent PRD (`dream-sk72`):

- User story 5
- User story 12
- User story 13

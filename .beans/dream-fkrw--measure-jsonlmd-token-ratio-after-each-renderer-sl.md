---
# dream-fkrw
title: Measure jsonl→md token ratio after each renderer slice
status: todo
type: task
priority: low
created_at: 2026-05-11T14:42:20Z
updated_at: 2026-05-11T14:42:20Z
parent: dream-kag4
---

Run `scripts/measure-tokens.sh` against real ingested Claude data after each renderer slice (dream-jouq, dream-9b9h, dream-q70e) lands. Goal: track the compression ratio tightening as per-tool reducers and post-passes come online.

Deferred from dream-jouq because the script needs real ingest output, and the agent doesn't touch real `~/.claude` per feedback_no_real_user_data.

## Acceptance criteria

- [ ] After each renderer slice, run `bun run ingest` (operator) then `scripts/measure-tokens.sh data` to capture the ratio.
- [ ] Record the overall ratio in the relevant slice bean's Summary or in a notes file.
- [ ] Once the renderer's compression is settled (after dream-q70e), decide whether to delete `scripts/measure-tokens.sh` per its own comment header.

## Out of scope

- Automating the measurement (it's a throwaway script).

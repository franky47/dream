---
# dream-lcey
title: 'Pi metadata + extension events: model_change, thinking_level_change, label, branch_summary, custom_message'
status: todo
type: feature
created_at: 2026-05-28T14:25:40Z
updated_at: 2026-05-28T14:25:40Z
parent: dream-gt5l
blocked_by:
    - dream-v6yu
---

## What to build

Render Pi's non-tool metadata and extension events inline on the active path so they appear in context rather than being silently dropped. Covers `model_change`, `thinking_level_change`, `session_info` (display name), `label` (with `targetId` back-reference resolved to render alongside the labeled entry), `branch_summary`, and `custom_message` (with `customType` discriminator routed through a generic per-customType fallback — no bespoke per-extension renderers yet). Bare `type:"custom"` entries (state, not in LLM context) remain skipped.

See parent PRD dream-gt5l "Pi-specific decisions" for the event list and the rule that bare `custom` is state-only.

## Acceptance criteria

- [ ] `model_change` and `thinking_level_change` entries on the active path render as small status lines inline where they occur (e.g. `> model: anthropic/claude-sonnet-4` style).
- [ ] `session_info` updates affect the rendered frontmatter `sessionName` field (latest wins).
- [ ] `label` entries resolve their `targetId` back-reference and render alongside the targeted entry (e.g. as a margin tag or trailing annotation). Labels pointing to off-active-path entries are skipped.
- [ ] `branch_summary` entries on the active path render as small summary blocks.
- [ ] `custom_message` entries route through a generic dispatcher keyed on `customType`; empty registry in v1 — everything renders via a fallback that pretty-prints the payload with the `customType` as a header.
- [ ] Bare `type:"custom"` entries continue to be skipped entirely.
- [ ] Tests cover: `model_change` + `thinking_level_change` rendered inline on the active path, `label` with `targetId` resolved to an active-path entry vs an off-path entry, `custom_message` rendered via fallback for the three observed `customType`s (`scheduler-task`, `scheduler-deleted`, `pi-splash`).
- [ ] `bun check` clean.

## User stories addressed

- User story 14

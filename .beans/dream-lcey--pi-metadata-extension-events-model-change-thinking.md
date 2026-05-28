---
# dream-lcey
title: 'Pi metadata + extension events: model_change, thinking_level_change, label, branch_summary, custom_message'
status: completed
type: feature
priority: normal
created_at: 2026-05-28T14:25:40Z
updated_at: 2026-05-28T19:10:00Z
parent: dream-gt5l
blocked_by:
    - dream-v6yu
---

## What to build

Render Pi's non-tool metadata and extension events inline on the active path so they appear in context rather than being silently dropped. Covers `model_change`, `thinking_level_change`, `session_info` (display name), `label` (with `targetId` back-reference resolved to render alongside the labeled entry), `branch_summary`, and `custom_message` (with `customType` discriminator routed through a generic per-customType fallback — no bespoke per-extension renderers yet). Bare `type:"custom"` entries (state, not in LLM context) remain skipped.

See parent PRD dream-gt5l "Pi-specific decisions" for the event list and the rule that bare `custom` is state-only.

## Acceptance criteria

- [x] `model_change` and `thinking_level_change` entries on the active path render as small status lines inline where they occur (e.g. `> model: anthropic/claude-sonnet-4` style).
- [x] `session_info` updates affect the rendered frontmatter `sessionName` field (latest wins).
- [x] `label` entries resolve their `targetId` back-reference and render alongside the targeted entry (e.g. as a margin tag or trailing annotation). Labels pointing to off-active-path entries are skipped.
- [x] `branch_summary` entries on the active path render as small summary blocks.
- [x] `custom_message` entries route through a generic dispatcher keyed on `customType`; empty registry in v1 — everything renders via a fallback that pretty-prints the payload with the `customType` as a header.
- [x] Bare `type:"custom"` entries continue to be skipped entirely.
- [x] Tests cover: `model_change` + `thinking_level_change` rendered inline on the active path, `label` with `targetId` resolved to an active-path entry vs an off-path entry, `custom_message` rendered via fallback for the three observed `customType`s (`scheduler-task`, `scheduler-deleted`, `pi-splash`).
- [x] `bun check` clean.

## User stories addressed

- User story 14

## Summary of Changes

`src/lib/pi/renderer/normalize.ts` now emits inline synthetic user-role messages for the four metadata/extension event types on the active path:

- `model_change` → text part `> model: <provider>/<modelId>`
- `thinking_level_change` → text part `> thinking_level: <level>`
- `branch_summary` → text part `<branch_summary>\n<summary>\n</branch_summary>`
- `label` → pre-scanned into a `Map<targetId, label[]>`, then appended as `[label: <name>]` text parts to the targeted message's parts list. Labels whose `targetId` is not in the active-path id set are dropped.

`session_info` was already handled in `buildFrontmatter` (latest wins → `sessionName`); no change needed. `custom_message` was already routed through `piFallback` via the `customType`-keyed user-role tool part from dream-v6yu; no change. Bare `type:"custom"` continues to be skipped.

Schemas are strict on required fields (`label.label`, `branchSummary.summary`, `modelChange.provider`+`modelId`, `thinkingLevelChange.thinkingLevel`) so unparseable records silently fall through to the baseline rather than emitting garbage.

5 new normalize tests added: inline rendering of model_change + thinking_level_change, branch_summary block, label-on-path annotation, label-off-path drop, custom_message fallback for the three observed customTypes (`scheduler-task`, `scheduler-deleted`, `pi-splash`).

### Follow-ups

- Label `text` field: real Pi sessions may carry the label string under `label`, `text`, or both. The schema accepts only `label` for now (matches the type name); if real fixtures show `text` instead, broaden the schema to accept the alternative.
- Bespoke per-customType renderers: the registry is intentionally empty. Add bespoke handlers for `scheduler-task`/`scheduler-deleted`/`pi-splash` when their payloads warrant shape-aware rendering.

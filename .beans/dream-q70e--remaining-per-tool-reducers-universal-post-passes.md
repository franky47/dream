---
# dream-q70e
title: Remaining per-tool reducers + universal post-passes
status: completed
type: feature
priority: normal
created_at: 2026-05-11T13:33:58Z
updated_at: 2026-05-11T15:12:28Z
parent: dream-kag4
blocked_by:
    - dream-jouq
---

## What to build

Land the remaining specialised tool reducers and the universal post-passes that apply to every tool body. Parallel-runnable with dream-9b9h — both depend only on the tracer (dream-jouq), neither on the other.

Remaining reducers (cases in the tools dispatch in `src/lib/claude/renderer/`):

- **Read / Glob / Grep** — self-closing `<tool name="Read" path="..."/>` (or `pattern="..."` for Glob/Grep). Body dropped at this layer; the assistant's subsequent text references whatever was retrieved.
- **Agent** — `<tool name="Agent" description="...">` with body containing the truncated `prompt` followed by the truncated result. Use the same head/tail truncation policy as Bash for both halves.
- **Skill** — self-closing `<tool name="Skill" args="..."/>`. No body. The skill's expanded content is fetchable elsewhere and the model's subsequent actions are ground truth.
- **WebFetch / WebSearch** — self-closing with `url="..."` (or `query="..."`). Body dropped.
- **TodoWrite** — single-line state diff inside `<tool name="TodoWrite">…</tool>` (e.g. `+ "do X" → in-progress; - "do Y" done`). Format is a compact textual diff of the todo state between adjacent TodoWrite calls.
- **AskUserQuestion** — `<tool name="AskUserQuestion">` with body containing a Q→A list, one line per question (`Q: <text> → A: <selected option>`).
- **Unknown / fallback** — preserved from slice dream-jouq's generic shape but now with head/tail truncation applied to bodies, so future tools degrade gracefully into compressed form.

Universal post-passes applied to every tool body before emission:

- **ANSI escape strip** — short regex helper; applied to every body coming from a tool that could carry terminal output.
- **Trailing whitespace trim** — per line.
- **Blank-run collapse** — ≥ 3 consecutive blank lines → 1.
- **Exact tool_result dedup** — per-session `Map<hash, turnNumber>` tracked at the dispatch layer. When a tool_result body hashes identically to a prior one in the same session, the body is replaced with `(same output as turn N)` referencing the earliest occurrence.

The dedup pass operates above the per-tool reducers (it sees the post-reducer body) so all reducers benefit uniformly.

See parent PRD dream-kag4 — Implementation Decisions for post-pass ordering and the universal-pass design.

## Acceptance criteria

- [x] Read / Glob / Grep reducers emit self-closing elements with inputs only; no body.
- [x] Agent reducer emits `description` attr and a body with truncated prompt + truncated result.
- [x] Skill reducer emits self-closing with `args` attr only.
- [x] WebFetch and WebSearch reducers emit self-closing with `url` or `query` attr only.
- [x] TodoWrite reducer emits a one-line state diff body.
- [x] AskUserQuestion reducer emits a Q→A list body.
- [x] Unknown-tool fallback retains the generic `<tool>` shape but with head/tail truncation applied.
- [x] ANSI escape strip applied to every tool body; verified with a fixture containing common ANSI sequences (colour, cursor-position, clear-line).
- [x] Trailing whitespace trimmed; ≥ 3 blank-line runs collapsed to 1.
- [x] Exact-byte tool_result dedup replaces repeats with `(same output as turn N)`; verified with a fixture where the same Bash command runs twice with identical stdout.
- [x] Fixture-driven tests covering each new reducer (happy path + empty input) and each universal post-pass in isolation, plus one integration test where multiple post-passes apply to the same body.
- [x] `bun run ingest` against the m4x claude data produces rendered files exercising the new reducers and post-passes; `scripts/measure-tokens.sh` shows a further-tightened ratio versus after slice dream-9b9h. (Wiring + `bun check` verified; real-data ingest handed off to operator per `feedback_no_real_user_data`. Token-ratio capture tracked under dream-fkrw.)
- [x] `bun check` passes.

## User stories addressed

- User story 12, 13, 18, 19, 25

## Summary of Changes

- New `src/lib/claude/renderer/post-pass.ts` with `stripAnsi`, `trimTrailingWhitespace`, `collapseBlankRuns`, and an `applyPostPasses` pipeline. ANSI regex is built from `String.fromCharCode(27)` so the literal stays out of source.
- `src/lib/claude/renderer/tools.ts` gained per-tool reducers: `renderReadTool`, `renderGlobTool`, `renderGrepTool`, `renderSkillTool`, `renderWebFetchTool`, `renderWebSearchTool` (all self-closing with a single relevant attr); `renderAgentTool` (description attr + truncated prompt + `---` separator + truncated result); `renderTodoWriteTool` (compact `+ "x"` / `"x" → status` / `- "x"` diff, self-closes when no diff); `renderAskUserQuestionTool` (Q→A list, parses `{answers:{...}}` JSON from result via Zod); `renderUnknownTool` (generic flat-attr fallback with head/tail truncation when a result is present).
- `src/lib/claude/renderer/render.ts` dispatch now routes each tool name to its reducer, applies universal post-passes to every `<tool>` body, and dedups bodies across the session — but only for `resultBacked` reducers (Bash, Agent, AskUserQuestion, Unknown) so that input-side bodies (Write, Edit, TodoWrite) don't get collapsed to `(same output as turn N)` when content coincidentally repeats. Tracks `lastTodos` and `currentTurn` on a `RenderState` so TodoWrite diffs are adjacency-based and dedup references the earliest turn.
- 19 new fixture tests cover each reducer (happy path + empty/missing inputs), each post-pass in isolation, and renderer-level integration: dedup-hits-on-Bash, Write-does-not-dedup, ANSI strip + blank-collapse on Bash output, TodoWrite no-op self-close, TodoWrite cross-turn state diff.
- `bun check`: 194 tests green.

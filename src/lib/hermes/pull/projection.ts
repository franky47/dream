import type { Database } from 'bun:sqlite'

// Hermes keeps its live transcripts in a SQLite state database rather than one
// file per session. This projection flattens the eligible rows into the same
// per-line JSONL shape the splitter and renderer consume, so remote reads over
// the sqlite3 CLI and local reads over bun:sqlite share one code path.
//
// The raw archive keeps every selected field, including the system prompt,
// model configuration, usage, lineage, cost, working-directory and platform
// origin. `model_config`, `tool_calls` and `origin_json` hold nested JSON, so
// they pass through `json()` (guarded by `json_valid`) to embed as real JSON. A
// blob that fails `json_valid` degrades to its ORIGINAL string, never NULL, so
// a malformed value survives the archive intact instead of vanishing.
//
// Platform identity lives in discrete columns and the rich `origin_json` blob.
// The projection keeps the two apart: `platform` holds only the discrete
// columns (which the Markdown renderer reads as scalar fields), while
// `originJson` carries the raw blob verbatim. Merging them here with
// `json_patch` risked an RFC-7396 delete of a discrete id, so the merged view
// is left for the renderer to build. Usage lives in discrete token columns,
// gathered here into one `usage` object. The Markdown renderer omits the noisy
// fields (system prompt, model config, reasoning) while keeping the archive
// complete.
//
// Hermes timestamps are REAL epoch seconds; the projection multiplies by 1000
// so every downstream consumer sees milliseconds.
//
// Inactive rows stay in the projection too. A `/undo` withdraws a turn from the
// live conversation (`active=0, compacted=0`) but the row keeps its place in the
// archive so the Markdown renderer can drop it while the raw record retains
// Hermes' audit trail. A compaction archives the prior window's rows
// (`active=0, compacted=1`) and inserts a fresh live summary row (`active=1`)
// whose content opens with a stable marker; the archived rows keep their place.
//
// Background sources are machine-driven work that never belongs in the human
// archive. Selecting by source (rather than by root-only lineage) lets a
// user-created branch through: a branch keeps its parent's human source, so it
// reads as its own human session even though it carries a `parent_session_id`.
// A delegated subagent carries the `subagent` source, so the same filter drops
// it without inspecting lineage.
const BACKGROUND_SOURCES = ['cron', 'webhook', 'subagent'] as const

// A rotated compaction continuation is a fresh physical session whose first
// message is the compaction summary Hermes carried across the rotation. That
// opening marker plus a `parent_session_id` is what separates a continuation
// from a user-created branch (whose first message is an ordinary turn) and from
// a subagent (already dropped by source). Hermes writes the marker as the exact
// literal prefix below; the CTE matches it with a fixed-length `substr` prefix
// comparison, which sidesteps LIKE's `%`/`_` metacharacters and the special
// characters (the em dash) the literal carries.
const COMPACTION_SUMMARY_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY]'
const COMPACTION_SUMMARY_PREFIX_LEN = COMPACTION_SUMMARY_PREFIX.length

function backgroundSourceList(): string {
  return BACKGROUND_SOURCES.map((s) => `'${s}'`).join(', ')
}

// Reads whichever column holds a nested JSON value, embedding it as real JSON
// when `json_valid` passes. A NULL stays NULL; a malformed blob degrades to its
// ORIGINAL string so the raw archive never silently drops a value it could not
// parse.
function jsonColumn(expr: string): string {
  return `CASE WHEN ${expr} IS NULL THEN NULL WHEN json_valid(${expr}) THEN json(${expr}) ELSE ${expr} END`
}

// Platform identity spans discrete columns and the richer `origin_json` blob.
// This object carries only the discrete columns; the frontmatter renderer reads
// them as scalar fields. The raw `origin_json` travels separately (see
// `originJson`) so no RFC-7396 merge can overwrite or delete a discrete id.
function platformObject(): string {
  return `json_object(
    'user_id', h.user_id,
    'session_key', h.session_key,
    'chat_id', h.chat_id,
    'chat_type', h.chat_type,
    'thread_id', h.thread_id,
    'display_name', h.display_name
  )`
}

function usageObject(): string {
  return `json_object(
    'messageCount', h.message_count,
    'toolCallCount', h.tool_call_count,
    'inputTokens', h.input_tokens,
    'outputTokens', h.output_tokens,
    'cacheReadTokens', h.cache_read_tokens,
    'cacheWriteTokens', h.cache_write_tokens,
    'reasoningTokens', h.reasoning_tokens,
    'estimatedCostUsd', h.estimated_cost_usd,
    'actualCostUsd', h.actual_cost_usd
  )`
}

// Groups a Hermes root and its rotated continuations into one logical session.
//
// `human` drops background work first, so continuations only ever attach to a
// human root. A session with a `parent_id` whose first `user` turn (the lowest
// `messages.id`, so leading or interleaved `session_meta` rows never mask it)
// opens with the compaction marker is a `continuation`. `chain` walks each
// continuation up to its non-continuation root, and `member` self-roots any
// session the walk never reached, so a continuation with a broken parent link
// still surfaces as its own logical session rather than vanishing.
//
// A logical session's `latest_message_time` is the newest message across every
// physical member, so selection and day routing follow the joined conversation
// rather than any single rotation.
function logicalSessionsCte(
  sinceLiteral: string,
  untilLiteral: string,
): string {
  return `
    human AS (
      SELECT id, source, parent_session_id AS parent_id, title, archived,
             system_prompt, model, model_config,
             user_id, session_key, chat_id, chat_type, thread_id, display_name,
             origin_json, started_at, ended_at, end_reason,
             cwd, git_branch, git_repo_root,
             billing_provider, billing_base_url, billing_mode,
             cost_status, cost_source, pricing_version,
             api_call_count, profile_name, rewind_count, expiry_finalized,
             message_count, tool_call_count,
             input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, reasoning_tokens,
             estimated_cost_usd, actual_cost_usd
      FROM sessions
      WHERE source IS NULL OR source NOT IN (${backgroundSourceList()})
    ),
    message_bounds AS (
      SELECT session_id, MAX(timestamp * 1000) AS last_ts
      FROM messages
      GROUP BY session_id
    ),
    continuation AS (
      SELECT h.id AS id, h.parent_id AS parent_id
      FROM human h
      WHERE h.parent_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM messages m
          WHERE m.session_id = h.id
            AND m.role = 'user'
            AND m.id = (
              SELECT MIN(m2.id)
              FROM messages m2
              WHERE m2.session_id = h.id AND m2.role = 'user'
            )
            AND substr(m.content, 1, ${COMPACTION_SUMMARY_PREFIX_LEN}) =
                '${COMPACTION_SUMMARY_PREFIX}'
        )
    ),
    chain AS (
      SELECT h.id AS id, h.id AS root_id, 0 AS depth
      FROM human h
      WHERE h.id NOT IN (SELECT id FROM continuation)
      UNION ALL
      SELECT c.id AS id, ch.root_id AS root_id, ch.depth + 1 AS depth
      FROM continuation c
      JOIN chain ch ON ch.id = c.parent_id
    ),
    member AS (
      SELECT id, root_id, depth FROM chain
      UNION ALL
      SELECT h.id AS id, h.id AS root_id, 0 AS depth
      FROM human h
      WHERE h.id NOT IN (SELECT id FROM chain)
    ),
    eligible AS (
      SELECT mem.root_id AS root_id, MAX(b.last_ts) AS latest_message_time
      FROM member mem
      JOIN message_bounds b ON b.session_id = mem.id
      GROUP BY mem.root_id
      HAVING MAX(b.last_ts) >= ${sinceLiteral}
         AND MAX(b.last_ts) < ${untilLiteral}
    )
  `
}

function projectionSqlTemplate(
  sinceLiteral: string,
  untilLiteral: string,
): string {
  return `
    WITH RECURSIVE ${logicalSessionsCte(sinceLiteral, untilLiteral)}
    SELECT row FROM (
      SELECT
        json_object(
          'type', 'session',
          'id', h.id,
          'sessionId', h.id,
          'logicalId', mem.root_id,
          'source', h.source,
          'title', h.title,
          'parentId', h.parent_id,
          'archived', h.archived,
          'createdAt', h.started_at * 1000,
          'endedAt', h.ended_at * 1000,
          'endReason', h.end_reason,
          'latestMessageTime', e.latest_message_time,
          'systemPrompt', h.system_prompt,
          'model', h.model,
          'modelConfig', ${jsonColumn('h.model_config')},
          'cwd', h.cwd,
          'gitBranch', h.git_branch,
          'gitRepoRoot', h.git_repo_root,
          'billingProvider', h.billing_provider,
          'billingBaseUrl', h.billing_base_url,
          'billingMode', h.billing_mode,
          'costStatus', h.cost_status,
          'costSource', h.cost_source,
          'pricingVersion', h.pricing_version,
          'apiCallCount', h.api_call_count,
          'profileName', h.profile_name,
          'rewindCount', h.rewind_count,
          'expiryFinalized', h.expiry_finalized,
          'sessionKey', h.session_key,
          'usage', ${usageObject()},
          'platform', ${platformObject()},
          'originJson', ${jsonColumn('h.origin_json')}
        ) AS row,
        mem.root_id AS logical_id,
        mem.depth AS depth,
        h.id AS session_id,
        0 AS type_rank,
        0 AS msg_id
      FROM human h
      JOIN member mem ON mem.id = h.id
      JOIN eligible e ON e.root_id = mem.root_id

      UNION ALL

      SELECT
        json_object(
          'type', 'message',
          'id', m.id,
          'sessionId', m.session_id,
          'logicalId', mem.root_id,
          'role', m.role,
          'content', m.content,
          'createdAt', m.timestamp * 1000,
          'active', m.active,
          'compacted', m.compacted,
          'effectDisposition', m.effect_disposition,
          'tokenCount', m.token_count,
          'finishReason', m.finish_reason,
          'observed', m.observed,
          'toolCallId', m.tool_call_id,
          'toolCalls', ${jsonColumn('m.tool_calls')},
          'toolName', m.tool_name,
          'reasoning', m.reasoning,
          'reasoningContent', m.reasoning_content,
          'reasoningDetails', m.reasoning_details,
          'codexReasoningItems', m.codex_reasoning_items,
          'codexMessageItems', m.codex_message_items,
          'platformMessageId', m.platform_message_id,
          'apiContent', m.api_content
        ) AS row,
        mem.root_id AS logical_id,
        mem.depth AS depth,
        m.session_id AS session_id,
        1 AS type_rank,
        m.id AS msg_id
      FROM messages m
      JOIN member mem ON mem.id = m.session_id
      JOIN eligible e ON e.root_id = mem.root_id
    )
    ORDER BY logical_id, depth, session_id, type_rank, msg_id
  `
}

export function buildProjectionSql(opts: {
  sinceMs: number
  untilMs: number
}): string {
  if (!Number.isInteger(opts.sinceMs) || opts.sinceMs < 0) {
    throw new RangeError(
      `sinceMs must be a non-negative integer, got ${opts.sinceMs}`,
    )
  }
  if (!Number.isInteger(opts.untilMs) || opts.untilMs < 0) {
    throw new RangeError(
      `untilMs must be a non-negative integer, got ${opts.untilMs}`,
    )
  }
  return projectionSqlTemplate(String(opts.sinceMs), String(opts.untilMs))
}

export function projectRows(opts: {
  db: Database
  sinceMs: number
  untilMs: number
}): string[] {
  const sql = buildProjectionSql({
    sinceMs: opts.sinceMs,
    untilMs: opts.untilMs,
  })
  return opts.db
    .query<{ row: string }, []>(sql)
    .all()
    .map((r) => r.row)
}

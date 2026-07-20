import type { Database } from 'bun:sqlite'

// Hermes keeps its live transcripts in a SQLite state database rather than one
// file per session. This projection flattens the eligible rows into the same
// per-line JSONL shape the splitter and renderer consume, so remote reads over
// the sqlite3 CLI and local reads over bun:sqlite share one code path.
//
// The raw archive keeps every selected field, including the system prompt,
// model settings, usage, lineage, archive state and platform origin. Columns
// that hold nested JSON pass through `json()` so the row embeds them as real
// JSON rather than an escaped string. The Markdown renderer omits the noisy
// ones (system prompt, model settings, reasoning) while keeping the archive
// complete.
//
// Inactive rows stay in the projection too. A `/undo` withdraws a turn from the
// live conversation but the row keeps its place in the archive, carrying its
// `active` state so the Markdown renderer can drop it while the raw record
// retains Hermes' audit trail.
//
// Background sources are machine-driven work that never belongs in the human
// archive. Selecting by source (rather than by root-only lineage) lets a
// user-created branch through: a branch keeps its parent's human source, so it
// reads as its own human session even though it carries a `parent_id`. A
// delegated subagent carries the `subagent` source, so the same filter drops it
// without inspecting lineage.
const BACKGROUND_SOURCES = ['cron', 'webhook', 'subagent'] as const

function backgroundSourceList(): string {
  return BACKGROUND_SOURCES.map((s) => `'${s}'`).join(', ')
}

// Eligible = a human-led session whose newest message lands inside the half-open
// [since, until) window and whose source is not background work. A null source
// is not background work, so the filter keeps it rather than letting SQL's
// three-valued `NULL NOT IN (...)` drop it. Archived sessions stay eligible:
// hiding a session in Hermes must not remove it from Dream, so there is no
// archive filter here.
function eligibleSessionsCte(
  sinceLiteral: string,
  untilLiteral: string,
): string {
  return `
    eligible AS (
      SELECT s.id AS id, latest.ts AS latest_message_time
      FROM sessions s
      JOIN (
        SELECT session_id, MAX(created_at) AS ts
        FROM messages
        GROUP BY session_id
      ) latest ON latest.session_id = s.id
      WHERE (s.source IS NULL OR s.source NOT IN (${backgroundSourceList()}))
        AND latest.ts >= ${sinceLiteral}
        AND latest.ts < ${untilLiteral}
    )
  `
}

function projectionSqlTemplate(
  sinceLiteral: string,
  untilLiteral: string,
): string {
  return `
    WITH ${eligibleSessionsCte(sinceLiteral, untilLiteral)}
    SELECT row FROM (
      SELECT
        json_object(
          'type', 'session',
          'id', s.id,
          'sessionId', s.id,
          'source', s.source,
          'title', s.title,
          'parentId', s.parent_id,
          'archived', s.archived,
          'createdAt', s.created_at,
          'latestMessageTime', e.latest_message_time,
          'systemPrompt', s.system_prompt,
          'model', s.model,
          'modelSettings', json(s.model_settings),
          'usage', json(s.usage),
          'platform', json(s.platform)
        ) AS row,
        s.id AS session_id,
        0 AS type_rank,
        s.created_at AS ts
      FROM sessions s
      JOIN eligible e ON e.id = s.id

      UNION ALL

      SELECT
        json_object(
          'type', 'message',
          'id', m.id,
          'sessionId', m.session_id,
          'turn', m.turn,
          'role', m.role,
          'content', m.content,
          'createdAt', m.created_at,
          'active', m.active,
          'reasoning', m.reasoning,
          'metadata', json(m.metadata)
        ) AS row,
        m.session_id,
        1 AS type_rank,
        m.created_at AS ts
      FROM messages m
      WHERE m.session_id IN (SELECT id FROM eligible)
    )
    ORDER BY session_id, type_rank, ts, row
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

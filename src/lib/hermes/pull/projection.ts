import type { Database } from 'bun:sqlite'

// Hermes keeps its live transcripts in a SQLite state database rather than one
// file per session. This projection flattens the eligible rows into the same
// per-line JSONL shape the splitter and renderer consume, so remote reads over
// the sqlite3 CLI and local reads over bun:sqlite share one code path.
//
// Eligible = a human-led root session (no parent) whose newest message lands
// inside the half-open [since, until) window. Cron, webhook and subagent
// sources are background work and stay out of the human archive.
//
// The raw archive keeps every selected field, including the system prompt,
// model settings, usage, lineage, archive state and platform origin. Columns
// that hold nested JSON pass through `json()` so the row embeds them as real
// JSON rather than an escaped string. The Markdown renderer omits the noisy
// ones (system prompt, model settings, reasoning) while keeping the archive
// complete.
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
      WHERE s.parent_id IS NULL
        AND s.source NOT IN ('cron', 'webhook', 'subagent')
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
          'createdAt', s.created_at,
          'latestMessageTime', e.latest_message_time,
          'parentId', s.parent_id,
          'archived', s.archived,
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

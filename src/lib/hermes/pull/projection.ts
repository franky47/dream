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
// retains Hermes' audit trail. Compaction itself has no dedicated flag: the
// summary row is a normal message whose `content` carries stable markers,
// retained verbatim, and the rows it archived keep their place in the raw
// record.
//
// Background sources are machine-driven work that never belongs in the human
// archive. Selecting by source (rather than by root-only lineage) lets a
// user-created branch through: a branch keeps its parent's human source, so it
// reads as its own human session even though it carries a `parent_id`. A
// delegated subagent carries the `subagent` source, so the same filter drops it
// without inspecting lineage.
const BACKGROUND_SOURCES = ['cron', 'webhook', 'subagent'] as const

// A rotated compaction continuation is a fresh physical session whose first
// message is the compaction summary Hermes carried across the rotation. That
// opening marker plus a `parent_id` is what separates a continuation from a
// user-created branch (whose first message is an ordinary turn) and from a
// subagent (already dropped by source). This is the same marker the renderer
// recognises, matched here as a literal LIKE pattern: SQLite LIKE treats only
// `%` and `_` as wildcards, and the marker holds neither.
const COMPACTION_SUMMARY_MARKER = '[hermes:compaction-summary]'

function backgroundSourceList(): string {
  return BACKGROUND_SOURCES.map((s) => `'${s}'`).join(', ')
}

// Groups a Hermes root and its rotated continuations into one logical session.
//
// `human` drops background work first, so continuations only ever attach to a
// human root. `message_bounds` finds each session's opening turn; a session
// with a `parent_id` whose opening turn carries the compaction marker is a
// `continuation`. `chain` walks each continuation up to its non-continuation
// root, and `member` self-roots any session the walk never reached, so a
// continuation with a broken parent link still surfaces as its own logical
// session rather than vanishing.
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
      SELECT id, source, parent_id, title, archived,
             system_prompt, model, model_settings, usage, platform, created_at
      FROM sessions
      WHERE source IS NULL OR source NOT IN (${backgroundSourceList()})
    ),
    message_bounds AS (
      SELECT session_id,
             MIN(created_at) AS first_ts,
             MAX(created_at) AS last_ts
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
          JOIN message_bounds b
            ON b.session_id = m.session_id AND b.first_ts = m.created_at
          WHERE m.session_id = h.id
            AND m.content LIKE '%${COMPACTION_SUMMARY_MARKER}%'
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
          'createdAt', h.created_at,
          'latestMessageTime', e.latest_message_time,
          'systemPrompt', h.system_prompt,
          'model', h.model,
          'modelSettings', json(h.model_settings),
          'usage', json(h.usage),
          'platform', json(h.platform)
        ) AS row,
        mem.root_id AS logical_id,
        mem.depth AS depth,
        h.id AS session_id,
        0 AS type_rank,
        h.created_at AS ts
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
          'turn', m.turn,
          'role', m.role,
          'content', m.content,
          'createdAt', m.created_at,
          'active', m.active,
          'reasoning', m.reasoning,
          'metadata', json(m.metadata)
        ) AS row,
        mem.root_id AS logical_id,
        mem.depth AS depth,
        m.session_id AS session_id,
        1 AS type_rank,
        m.created_at AS ts
      FROM messages m
      JOIN member mem ON mem.id = m.session_id
      JOIN eligible e ON e.root_id = mem.root_id
    )
    ORDER BY logical_id, depth, session_id, type_rank, ts, row
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

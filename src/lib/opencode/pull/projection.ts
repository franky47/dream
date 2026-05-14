import type { Database } from 'bun:sqlite'

function projectionSqlTemplate(
  sinceLiteral: string,
  untilLiteral: string,
): string {
  return `
    SELECT row FROM (
      SELECT
        json_object(
          'type', 'session',
          'id', s.id,
          'sessionId', s.id,
          'parentId', s.parent_id,
          'title', s.title,
          'directory', s.directory,
          'version', s.version,
          'time_updated', s.time_updated,
          'project', json_object(
            'id', pr.id,
            'worktree', pr.worktree,
            'vcs', pr.vcs,
            'name', pr.name
          ),
          'workspace', CASE WHEN ws.id IS NULL THEN NULL ELSE json_object(
            'id', ws.id,
            'type', ws.type,
            'name', ws.name,
            'branch', ws.branch,
            'directory', ws.directory
          ) END
        ) AS row,
        s.id AS session_id,
        s.time_created AS ts,
        0 AS type_rank
      FROM session s
      JOIN project pr ON pr.id = s.project_id
      LEFT JOIN workspace ws ON ws.id = s.workspace_id
      WHERE s.parent_id IS NULL
        AND s.time_updated > ${sinceLiteral}
        AND s.time_updated < ${untilLiteral}

      UNION ALL

      SELECT
        json_patch(
          data,
          json_object(
            'type', 'message',
            'id', m.id,
            'sessionId', m.session_id
          )
        ) AS row,
        m.session_id,
        m.time_created AS ts,
        1 AS type_rank
      FROM message m
      WHERE m.session_id IN (
        SELECT id FROM session WHERE parent_id IS NULL AND time_updated > ${sinceLiteral} AND time_updated < ${untilLiteral}
      )

      UNION ALL

      SELECT
        json_patch(
          json_patch(
            data,
            json_object('partType', json_extract(data, '$.type'))
          ),
          json_object(
            'type', 'part',
            'id', p.id,
            'sessionId', p.session_id,
            'messageId', p.message_id
          )
        ) AS row,
        p.session_id,
        p.time_created AS ts,
        2 AS type_rank
      FROM part p
      WHERE p.session_id IN (
        SELECT id FROM session WHERE parent_id IS NULL AND time_updated > ${sinceLiteral} AND time_updated < ${untilLiteral}
      )
    )
    ORDER BY session_id, ts, type_rank
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

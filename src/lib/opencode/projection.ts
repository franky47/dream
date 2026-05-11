import type { Database } from 'bun:sqlite'

const PROJECTION_SQL = `
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
      AND s.time_updated > ?

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
      SELECT id FROM session WHERE parent_id IS NULL AND time_updated > ?
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
      SELECT id FROM session WHERE parent_id IS NULL AND time_updated > ?
    )
  )
  ORDER BY session_id, ts, type_rank
`

export function projectRows(opts: { db: Database; sinceMs: number }): string[] {
  const stmt = opts.db.query<{ row: string }, [number, number, number]>(
    PROJECTION_SQL,
  )
  return stmt.all(opts.sinceMs, opts.sinceMs, opts.sinceMs).map((r) => r.row)
}

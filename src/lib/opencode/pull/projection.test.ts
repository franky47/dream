import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { buildProjectionSql, projectRows } from './projection.ts'

const rowSchema = z.record(z.string(), z.unknown())
function parseRows(rows: ReadonlyArray<string>): Record<string, unknown>[] {
  return rows.map((s) => rowSchema.parse(JSON.parse(s)))
}

// Far-future upper bound: keeps the existing since-only cases unaffected.
const UNTIL_MS = 9_999_999_999_999

let workDir: string
let dbPath: string

const SCHEMA_STATEMENTS = [
  `CREATE TABLE project (
    id TEXT PRIMARY KEY,
    worktree TEXT NOT NULL,
    vcs TEXT,
    name TEXT,
    icon_url TEXT,
    icon_color TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_initialized INTEGER,
    sandboxes TEXT NOT NULL,
    commands TEXT,
    icon_url_override TEXT
  )`,
  `CREATE TABLE workspace (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    branch TEXT,
    directory TEXT,
    extra TEXT,
    project_id TEXT NOT NULL
  )`,
  `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    workspace_id TEXT,
    path TEXT
  )`,
  `CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
]

function openFreshDb(): Database {
  const db = new Database(dbPath, { create: true })
  for (const stmt of SCHEMA_STATEMENTS) {
    db.prepare(stmt).run()
  }
  return db
}

function insertProject(
  db: Database,
  p: { id: string; worktree: string; name: string },
): void {
  db.prepare(
    `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
     VALUES (?, ?, 'git', ?, 0, 0, '[]')`,
  ).run(p.id, p.worktree, p.name)
}

function insertWorkspace(
  db: Database,
  w: { id: string; projectId: string; branch: string; directory: string },
): void {
  db.prepare(
    `INSERT INTO workspace (id, type, name, branch, directory, project_id)
     VALUES (?, 'local', '', ?, ?, ?)`,
  ).run(w.id, w.branch, w.directory, w.projectId)
}

function insertMessage(
  db: Database,
  m: { id: string; sessionId: string; timeCreated: number; data: object },
): void {
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(m.id, m.sessionId, m.timeCreated, m.timeCreated, JSON.stringify(m.data))
}

function insertPart(
  db: Database,
  p: {
    id: string
    messageId: string
    sessionId: string
    timeCreated: number
    data: object
  },
): void {
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    p.id,
    p.messageId,
    p.sessionId,
    p.timeCreated,
    p.timeCreated,
    JSON.stringify(p.data),
  )
}

function insertSession(
  db: Database,
  s: {
    id: string
    projectId: string
    workspaceId: string | null
    parentId?: string | null
    title?: string
    directory?: string
    timeCreated?: number
    timeUpdated?: number
  },
): void {
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, workspace_id)
     VALUES (?, ?, ?, 'slug', ?, ?, '0.x', ?, ?, ?)`,
  ).run(
    s.id,
    s.projectId,
    s.parentId ?? null,
    s.directory ?? '/repo',
    s.title ?? 'untitled',
    s.timeCreated ?? 1_000,
    s.timeUpdated ?? 1_000,
    s.workspaceId,
  )
}

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-opencode-projection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(workDir, { recursive: true })
  dbPath = path.join(workDir, 'opencode.db')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('buildProjectionSql', () => {
  test('inlines sinceMs as a literal integer at every filter site', () => {
    const sql = buildProjectionSql({ sinceMs: 1_234_567, untilMs: UNTIL_MS })
    expect(sql).toContain('time_updated > 1234567')
    expect(sql).not.toContain('?')
  })

  test('inlines untilMs as a strict upper bound at every filter site', () => {
    const sql = buildProjectionSql({ sinceMs: 0, untilMs: 8_888_888 })
    expect(sql).toContain('time_updated < 8888888')
    expect(sql).not.toContain('?')
  })

  test('executes against a database without bound parameters', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_1',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 5_000,
    })
    const sql = buildProjectionSql({ sinceMs: 0, untilMs: UNTIL_MS })
    const rows = db
      .query<{ row: string }, []>(sql)
      .all()
      .map((r) => r.row)
    expect(rows).toHaveLength(1)
    db.close()
  })
})

describe('projectRows', () => {
  test('emits a session header row for a single root session', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_1',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      title: 'hello',
      timeCreated: 5_000,
      timeUpdated: 5_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('session')
    expect(rows[0]?.id).toBe('ses_1')
    expect(rows[0]?.sessionId).toBe('ses_1')
    expect(rows[0]?.title).toBe('hello')
    db.close()
  })

  test('emits session header followed by its message row', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_1',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 6_000,
    })
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_1',
      timeCreated: 6_000,
      data: { role: 'user', mode: 'build' },
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows).toHaveLength(2)
    expect(rows[0]?.type).toBe('session')
    expect(rows[1]?.type).toBe('message')
    expect(rows[1]?.id).toBe('msg_1')
    expect(rows[1]?.sessionId).toBe('ses_1')
    expect(rows[1]?.role).toBe('user')
    expect(rows[1]?.mode).toBe('build')
    db.close()
  })

  test('emits part rows after the message that contains them', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_1',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 8_000,
    })
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_1',
      timeCreated: 6_000,
      data: { role: 'assistant' },
    })
    insertPart(db, {
      id: 'prt_1',
      messageId: 'msg_1',
      sessionId: 'ses_1',
      timeCreated: 7_000,
      data: { type: 'text', text: 'hello world' },
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows).toHaveLength(3)
    expect(rows[0]?.type).toBe('session')
    expect(rows[1]?.type).toBe('message')
    expect(rows[2]?.type).toBe('part')
    expect(rows[2]?.id).toBe('prt_1')
    expect(rows[2]?.messageId).toBe('msg_1')
    expect(rows[2]?.sessionId).toBe('ses_1')
    expect(rows[2]?.text).toBe('hello world')
    expect(rows[2]?.partType).toBe('text')
    db.close()
  })

  test('excludes subagent (child) sessions', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_root',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 5_000,
    })
    insertSession(db, {
      id: 'ses_child',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      parentId: 'ses_root',
      timeCreated: 6_000,
      timeUpdated: 6_000,
    })
    insertMessage(db, {
      id: 'msg_child',
      sessionId: 'ses_child',
      timeCreated: 7_000,
      data: { role: 'user' },
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('ses_root')
    db.close()
  })

  test('excludes sessions updated at or after the until cursor', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_in',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 1_000,
      timeUpdated: 4_000,
    })
    insertSession(db, {
      id: 'ses_after',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 1_000,
      timeUpdated: 5_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: 5_000 }))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('ses_in')
    db.close()
  })

  test('session header carries time_updated', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_1',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 7_500,
    })

    const row = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))[0]
    expect(row?.time_updated).toBe(7_500)
    db.close()
  })

  test('honours the since cursor on session.time_updated', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_old',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 100,
      timeUpdated: 100,
    })
    insertSession(db, {
      id: 'ses_new',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 5_000,
    })

    const rows = parseRows(
      projectRows({ db, sinceMs: 1_000, untilMs: UNTIL_MS }),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('ses_new')
    db.close()
  })

  test('session header lands before a message with the same time_created', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo',
    })
    insertSession(db, {
      id: 'ses_1',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 5_000,
    })
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_1',
      timeCreated: 5_000,
      data: { role: 'user' },
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows[0]?.type).toBe('session')
    expect(rows[1]?.type).toBe('message')
  })

  test('session header denormalises project and workspace metadata', () => {
    const db = openFreshDb()
    insertProject(db, { id: 'prj_a', worktree: '/repo', name: 'dream' })
    insertWorkspace(db, {
      id: 'wks_a',
      projectId: 'prj_a',
      branch: 'main',
      directory: '/repo/wt',
    })
    insertSession(db, {
      id: 'ses_1',
      projectId: 'prj_a',
      workspaceId: 'wks_a',
      timeCreated: 5_000,
      timeUpdated: 5_000,
    })

    const row = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))[0]
    const project = rowSchema.parse(row?.project)
    expect(project.id).toBe('prj_a')
    expect(project.worktree).toBe('/repo')
    expect(project.vcs).toBe('git')
    expect(project.name).toBe('dream')

    const workspace = rowSchema.parse(row?.workspace)
    expect(workspace.id).toBe('wks_a')
    expect(workspace.branch).toBe('main')
    expect(workspace.directory).toBe('/repo/wt')
    db.close()
  })
})

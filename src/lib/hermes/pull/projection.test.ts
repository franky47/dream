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

const UNTIL_MS = 9_999_999_999_999

let workDir: string
let dbPath: string

const SCHEMA_STATEMENTS = [
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    parent_id TEXT,
    title TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
]

function openFreshDb(): Database {
  const db = new Database(dbPath, { create: true })
  for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run()
  return db
}

function insertSession(
  db: Database,
  s: {
    id: string
    source?: string
    parentId?: string | null
    title?: string
    archived?: number
    createdAt?: number
  },
): void {
  db.prepare(
    `INSERT INTO sessions (id, source, parent_id, title, archived, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.source ?? 'discord',
    s.parentId ?? null,
    s.title ?? 'untitled',
    s.archived ?? 0,
    s.createdAt ?? 1_000,
  )
}

function insertMessage(
  db: Database,
  m: {
    id: string
    sessionId: string
    turn?: number
    role?: string
    content?: string
    createdAt: number
  },
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, turn, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    m.sessionId,
    m.turn ?? 1,
    m.role ?? 'user',
    m.content ?? 'hello',
    m.createdAt,
  )
}

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-hermes-projection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(workDir, { recursive: true })
  dbPath = path.join(workDir, 'state.db')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('buildProjectionSql', () => {
  test('inlines sinceMs as a half-open lower bound', () => {
    const sql = buildProjectionSql({ sinceMs: 1_234_567, untilMs: UNTIL_MS })
    expect(sql).toContain('>= 1234567')
    expect(sql).not.toContain('?')
  })

  test('inlines untilMs as a strict upper bound', () => {
    const sql = buildProjectionSql({ sinceMs: 0, untilMs: 8_888_888 })
    expect(sql).toContain('< 8888888')
    expect(sql).not.toContain('?')
  })

  test('rejects a non-integer sinceMs', () => {
    expect(() =>
      buildProjectionSql({ sinceMs: 1.5, untilMs: UNTIL_MS }),
    ).toThrow(RangeError)
  })
})

describe('projectRows', () => {
  test('emits a session header followed by its messages, ordered by time', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', title: 'hi', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_1',
      role: 'user',
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 'msg_2',
      sessionId: 'ses_1',
      role: 'assistant',
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows).toHaveLength(3)
    expect(rows[0]?.type).toBe('session')
    expect(rows[0]?.id).toBe('ses_1')
    expect(rows[0]?.sessionId).toBe('ses_1')
    expect(rows[0]?.title).toBe('hi')
    expect(rows[0]?.source).toBe('discord')
    expect(rows[1]?.type).toBe('message')
    expect(rows[1]?.id).toBe('msg_1')
    expect(rows[2]?.id).toBe('msg_2')
    db.close()
  })

  test('session header carries the latest message time for routing', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', createdAt: 5_000 })
    insertMessage(db, { id: 'msg_1', sessionId: 'ses_1', createdAt: 6_000 })
    insertMessage(db, { id: 'msg_2', sessionId: 'ses_1', createdAt: 8_500 })

    const row = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))[0]
    expect(row?.latestMessageTime).toBe(8_500)
    db.close()
  })

  test('excludes cron, webhook and subagent sources', () => {
    const db = openFreshDb()
    for (const source of ['cron', 'webhook', 'subagent']) {
      insertSession(db, { id: `ses_${source}`, source, createdAt: 5_000 })
      insertMessage(db, {
        id: `msg_${source}`,
        sessionId: `ses_${source}`,
        createdAt: 6_000,
      })
    }
    insertSession(db, { id: 'ses_human', source: 'cli', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_human',
      sessionId: 'ses_human',
      createdAt: 6_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows.filter((r) => r.type === 'session')).toHaveLength(1)
    expect(rows[0]?.id).toBe('ses_human')
    db.close()
  })

  test('excludes child (non-root) sessions', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_root',
      sessionId: 'ses_root',
      createdAt: 6_000,
    })
    insertSession(db, {
      id: 'ses_child',
      parentId: 'ses_root',
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 'msg_child',
      sessionId: 'ses_child',
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(rows.filter((r) => r.type === 'session')).toHaveLength(1)
    expect(rows[0]?.id).toBe('ses_root')
    db.close()
  })

  test('selects by latest message time inside the half-open window', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_at_since', createdAt: 100 })
    insertMessage(db, {
      id: 'msg_at_since',
      sessionId: 'ses_at_since',
      createdAt: 1_000,
    })
    insertSession(db, { id: 'ses_below', createdAt: 100 })
    insertMessage(db, {
      id: 'msg_below',
      sessionId: 'ses_below',
      createdAt: 999,
    })
    insertSession(db, { id: 'ses_at_until', createdAt: 100 })
    insertMessage(db, {
      id: 'msg_at_until',
      sessionId: 'ses_at_until',
      createdAt: 5_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 1_000, untilMs: 5_000 }))

    const ids = rows.filter((r) => r.type === 'session').map((r) => r.id)
    expect(ids).toEqual(['ses_at_since'])
    db.close()
  })

  test('excludes sessions with no messages', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_empty', createdAt: 5_000 })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    expect(rows).toHaveLength(0)
    db.close()
  })
})

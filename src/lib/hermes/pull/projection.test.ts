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
    source TEXT,
    parent_id TEXT,
    title TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    system_prompt TEXT,
    model TEXT,
    model_settings TEXT,
    usage TEXT,
    platform TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    metadata TEXT,
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
    source?: string | null
    parentId?: string | null
    title?: string
    archived?: number
    systemPrompt?: string | null
    model?: string | null
    modelSettings?: string | null
    usage?: string | null
    platform?: string | null
    createdAt?: number
  },
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, source, parent_id, title, archived,
        system_prompt, model, model_settings, usage, platform, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.id,
    s.source === undefined ? 'discord' : s.source,
    s.parentId ?? null,
    s.title ?? 'untitled',
    s.archived ?? 0,
    s.systemPrompt ?? null,
    s.model ?? null,
    s.modelSettings ?? null,
    s.usage ?? null,
    s.platform ?? null,
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
    reasoning?: string | null
    metadata?: string | null
    createdAt: number
  },
): void {
  db.prepare(
    `INSERT INTO messages
       (id, session_id, turn, role, content, reasoning, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    m.sessionId,
    m.turn ?? 1,
    m.role ?? 'user',
    m.content ?? 'hello',
    m.reasoning ?? null,
    m.metadata ?? null,
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

  test('includes a user-created branch as its own human session', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'discord', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_root',
      sessionId: 'ses_root',
      createdAt: 6_000,
    })
    insertSession(db, {
      id: 'ses_branch',
      source: 'discord',
      parentId: 'ses_root',
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 'msg_branch',
      sessionId: 'ses_branch',
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    const sessions = rows.filter((r) => r.type === 'session')
    const ids = sessions.map((r) => r.id)
    expect(ids).toHaveLength(2)
    expect(ids).toContain('ses_root')
    expect(ids).toContain('ses_branch')
    const branch = sessions.find((r) => r.id === 'ses_branch')
    expect(branch?.parentId).toBe('ses_root')
    db.close()
  })

  test('excludes a delegated subagent child', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'cli', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_root',
      sessionId: 'ses_root',
      createdAt: 6_000,
    })
    insertSession(db, {
      id: 'ses_subagent',
      source: 'subagent',
      parentId: 'ses_root',
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 'msg_subagent',
      sessionId: 'ses_subagent',
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    const ids = rows.filter((r) => r.type === 'session').map((r) => r.id)
    expect(ids).toEqual(['ses_root'])
    db.close()
  })

  test('keeps a session whose source is null', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_null', source: null, createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_null',
      sessionId: 'ses_null',
      createdAt: 6_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    const ids = rows.filter((r) => r.type === 'session').map((r) => r.id)
    expect(ids).toEqual(['ses_null'])
    db.close()
  })

  test('selects an archived session and retains its archive and lineage', () => {
    const db = openFreshDb()
    insertSession(db, {
      id: 'ses_archived',
      source: 'discord',
      parentId: 'ses_origin',
      archived: 1,
      createdAt: 5_000,
    })
    insertMessage(db, {
      id: 'msg_archived',
      sessionId: 'ses_archived',
      createdAt: 6_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    const session = rows.find((r) => r.type === 'session')
    expect(session?.id).toBe('ses_archived')
    expect(session?.archived).toBe(1)
    expect(session?.parentId).toBe('ses_origin')
    db.close()
  })

  test('marks a non-archived session with archived 0', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_live', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_live',
      sessionId: 'ses_live',
      createdAt: 6_000,
    })

    const row = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))[0]
    expect(row?.archived).toBe(0)
    expect(row?.parentId).toBeNull()
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

  test('retains full session metadata, embedding nested JSON as JSON', () => {
    const db = openFreshDb()
    insertSession(db, {
      id: 'ses_1',
      archived: 1,
      systemPrompt: 'You are Hermes.',
      model: 'llama-swap/big',
      modelSettings: JSON.stringify({ temperature: 0.7, maxTokens: 4096 }),
      usage: JSON.stringify({ inputTokens: 120, outputTokens: 340 }),
      platform: JSON.stringify({ channelId: '42', guildId: '7' }),
      createdAt: 5_000,
    })
    insertMessage(db, { id: 'msg_1', sessionId: 'ses_1', createdAt: 6_000 })

    const session = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    )[0]

    expect(session?.parentId).toBeNull()
    expect(session?.archived).toBe(1)
    expect(session?.systemPrompt).toBe('You are Hermes.')
    expect(session?.model).toBe('llama-swap/big')
    expect(session?.modelSettings).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
    })
    expect(session?.usage).toEqual({ inputTokens: 120, outputTokens: 340 })
    expect(session?.platform).toEqual({ channelId: '42', guildId: '7' })
    db.close()
  })

  test('retains message reasoning and provider-specific metadata', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_1',
      role: 'assistant',
      content: 'The answer is 42.',
      reasoning: 'First I considered the alternatives...',
      metadata: JSON.stringify({ finishReason: 'stop', providerId: 'echo' }),
      createdAt: 6_000,
    })

    const message = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    )[1]

    expect(message?.reasoning).toBe('First I considered the alternatives...')
    expect(message?.metadata).toEqual({
      finishReason: 'stop',
      providerId: 'echo',
    })
    db.close()
  })

  test('emits null for missing optional metadata without inventing values', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', createdAt: 5_000 })
    insertMessage(db, { id: 'msg_1', sessionId: 'ses_1', createdAt: 6_000 })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    const session = rows[0]
    const message = rows[1]

    expect(session?.systemPrompt).toBeNull()
    expect(session?.model).toBeNull()
    expect(session?.modelSettings).toBeNull()
    expect(session?.usage).toBeNull()
    expect(session?.platform).toBeNull()
    expect(message?.reasoning).toBeNull()
    expect(message?.metadata).toBeNull()
    db.close()
  })
})

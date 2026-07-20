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
    active INTEGER NOT NULL DEFAULT 1,
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
    active?: number
    reasoning?: string | null
    metadata?: string | null
    createdAt: number
  },
): void {
  db.prepare(
    `INSERT INTO messages
       (id, session_id, turn, role, content, active, reasoning, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    m.sessionId,
    m.turn ?? 1,
    m.role ?? 'user',
    m.content ?? 'hello',
    m.active ?? 1,
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

  test('retains rewound (inactive) rows carrying their active state', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_live',
      sessionId: 'ses_1',
      content: 'kept in the live conversation',
      active: 1,
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 'msg_rewound',
      sessionId: 'ses_1',
      content: 'withdrawn with /undo',
      active: 0,
      createdAt: 7_000,
    })

    const messages = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    ).filter((r) => r.type === 'message')

    expect(messages).toHaveLength(2)
    expect(messages[0]?.active).toBe(1)
    expect(messages[1]?.id).toBe('msg_rewound')
    expect(messages[1]?.active).toBe(0)
    expect(messages[1]?.content).toBe('withdrawn with /undo')
    db.close()
  })

  test('retains pre-compaction rows, the summary row and live rows in order', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_old',
      sessionId: 'ses_1',
      content: 'earlier question',
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 'msg_summary',
      sessionId: 'ses_1',
      role: 'assistant',
      content:
        '[hermes:compaction-summary]\nWe discussed X.\n[/hermes:compaction-summary]',
      createdAt: 7_000,
    })
    insertMessage(db, {
      id: 'msg_live',
      sessionId: 'ses_1',
      content: 'follow-up question',
      createdAt: 8_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    const messages = rows.filter((r) => r.type === 'message')

    expect(messages.map((m) => m.id)).toEqual([
      'msg_old',
      'msg_summary',
      'msg_live',
    ])
    expect(messages[1]?.content).toContain('[hermes:compaction-summary]')
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
    expect(message?.active).toBe(1)
    expect(message?.reasoning).toBeNull()
    expect(message?.metadata).toBeNull()
    db.close()
  })
})

const SUMMARY_CONTENT =
  '[hermes:compaction-summary]\nEarlier we did X.\n[/hermes:compaction-summary]'

function logicalIds(rows: Record<string, unknown>[]): unknown[] {
  return rows.filter((r) => r.type === 'session').map((r) => r.logicalId)
}

function physicalIds(rows: Record<string, unknown>[]): unknown[] {
  return rows.filter((r) => r.type === 'session').map((r) => r.id)
}

describe('rotated continuation chains', () => {
  test('joins a continuation under its root as one logical session', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'discord', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_root',
      sessionId: 'ses_root',
      content: 'first question',
      createdAt: 6_000,
    })
    insertSession(db, {
      id: 'ses_cont',
      source: 'discord',
      parentId: 'ses_root',
      createdAt: 7_000,
    })
    insertMessage(db, {
      id: 'msg_summary',
      sessionId: 'ses_cont',
      role: 'assistant',
      content: SUMMARY_CONTENT,
      createdAt: 7_000,
    })
    insertMessage(db, {
      id: 'msg_after',
      sessionId: 'ses_cont',
      content: 'follow-up',
      createdAt: 8_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    // Both physical sessions survive, joined under the root's logical id.
    expect(physicalIds(rows)).toEqual(['ses_root', 'ses_cont'])
    expect(logicalIds(rows)).toEqual(['ses_root', 'ses_root'])

    // Root header comes first, its message before the continuation, and the
    // continuation keeps its own parent link.
    expect(rows.map((r) => r.id)).toEqual([
      'ses_root',
      'msg_root',
      'ses_cont',
      'msg_summary',
      'msg_after',
    ])
    const cont = rows.find((r) => r.id === 'ses_cont')
    expect(cont?.parentId).toBe('ses_root')
    db.close()
  })

  test('joins several continuations in chain order', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'cli', createdAt: 1_000 })
    insertMessage(db, {
      id: 'm_root',
      sessionId: 'ses_root',
      createdAt: 1_500,
    })
    insertSession(db, {
      id: 'ses_c1',
      source: 'cli',
      parentId: 'ses_root',
      createdAt: 2_000,
    })
    insertMessage(db, {
      id: 'm_c1',
      sessionId: 'ses_c1',
      role: 'assistant',
      content: SUMMARY_CONTENT,
      createdAt: 2_000,
    })
    insertSession(db, {
      id: 'ses_c2',
      source: 'cli',
      parentId: 'ses_c1',
      createdAt: 3_000,
    })
    insertMessage(db, {
      id: 'm_c2',
      sessionId: 'ses_c2',
      role: 'assistant',
      content: SUMMARY_CONTENT,
      createdAt: 3_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(physicalIds(rows)).toEqual(['ses_root', 'ses_c1', 'ses_c2'])
    expect(logicalIds(rows)).toEqual(['ses_root', 'ses_root', 'ses_root'])
    db.close()
  })

  test('selects a chain by its logical latest even when the root is stale', () => {
    const db = openFreshDb()
    // The root's own newest message predates the window; only the continuation
    // is recent. The joined session must still be pulled whole.
    insertSession(db, { id: 'ses_root', source: 'discord', createdAt: 100 })
    insertMessage(db, {
      id: 'msg_root',
      sessionId: 'ses_root',
      content: 'old question',
      createdAt: 500,
    })
    insertSession(db, {
      id: 'ses_cont',
      source: 'discord',
      parentId: 'ses_root',
      createdAt: 5_000,
    })
    insertMessage(db, {
      id: 'msg_summary',
      sessionId: 'ses_cont',
      role: 'assistant',
      content: SUMMARY_CONTENT,
      createdAt: 5_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 1_000, untilMs: 9_000 }))

    expect(physicalIds(rows)).toEqual(['ses_root', 'ses_cont'])
    const header = rows.find((r) => r.id === 'ses_root')
    expect(header?.latestMessageTime).toBe(5_000)
    db.close()
  })

  test('excludes a chain whose logical latest is beyond the window', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'discord', createdAt: 100 })
    insertMessage(db, {
      id: 'msg_root',
      sessionId: 'ses_root',
      createdAt: 500,
    })
    insertSession(db, {
      id: 'ses_cont',
      source: 'discord',
      parentId: 'ses_root',
      createdAt: 9_000,
    })
    insertMessage(db, {
      id: 'msg_summary',
      sessionId: 'ses_cont',
      role: 'assistant',
      content: SUMMARY_CONTENT,
      createdAt: 9_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 1_000, untilMs: 5_000 }))
    expect(rows).toHaveLength(0)
    db.close()
  })

  test('does not join a user branch that opens with an ordinary turn', () => {
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
      content: 'a fresh human question',
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    // Two separate logical sessions, each its own root.
    const ids = logicalIds(rows)
    expect(ids).toHaveLength(2)
    expect(ids).toContain('ses_root')
    expect(ids).toContain('ses_branch')
    db.close()
  })

  test('does not join a subagent that opens with a compaction-like message', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'cli', createdAt: 5_000 })
    insertMessage(db, {
      id: 'msg_root',
      sessionId: 'ses_root',
      createdAt: 6_000,
    })
    insertSession(db, {
      id: 'ses_sub',
      source: 'subagent',
      parentId: 'ses_root',
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 'msg_sub',
      sessionId: 'ses_sub',
      role: 'assistant',
      content: SUMMARY_CONTENT,
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(physicalIds(rows)).toEqual(['ses_root'])
    expect(logicalIds(rows)).toEqual(['ses_root'])
    db.close()
  })

  test('self-roots a continuation whose parent link is broken', () => {
    const db = openFreshDb()
    // The parent session is missing, so the orphan cannot vanish: it becomes
    // its own logical session.
    insertSession(db, {
      id: 'ses_orphan',
      source: 'discord',
      parentId: 'ses_missing',
      createdAt: 5_000,
    })
    insertMessage(db, {
      id: 'msg_summary',
      sessionId: 'ses_orphan',
      role: 'assistant',
      content: SUMMARY_CONTENT,
      createdAt: 6_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(physicalIds(rows)).toEqual(['ses_orphan'])
    expect(logicalIds(rows)).toEqual(['ses_orphan'])
    const header = rows.find((r) => r.id === 'ses_orphan')
    expect(header?.parentId).toBe('ses_missing')
    db.close()
  })
})

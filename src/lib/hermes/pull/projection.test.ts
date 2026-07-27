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

// Hermes stores a compaction summary as a live (`active=1`) user row whose
// content opens with this fixed instruction prefix. Only the prefix drives
// detection, so the synthetic body stays short.
const COMPACTION_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY]'
const SUMMARY_CONTENT = `${COMPACTION_PREFIX} handoff, avoid repeating it:\nEarlier we did X.`

let workDir: string
let dbPath: string

// The real Echo schema, copied verbatim from the live state db's DDL so no live
// column can silently drop out of the projection: rebuilding a reduced copy is
// what let `ended_at` (and its neighbours) go missing before. Only the two FTS5
// virtual tables are added here — the live dump omits their CREATE statements,
// yet the message triggers below reference them, so the fixture supplies a
// minimal pair to keep inserts working. Every data value inserted is synthetic.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    session_key TEXT,
    chat_id TEXT,
    chat_type TEXT,
    thread_id TEXT,
    display_name TEXT,
    origin_json TEXT,
    expiry_finalized INTEGER DEFAULT 0,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cwd TEXT,
    git_branch TEXT,
    git_repo_root TEXT,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    title TEXT,
    api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT,
    handoff_platform TEXT,
    handoff_error TEXT,
    compression_failure_cooldown_until REAL,
    compression_failure_error TEXT,
    compression_fallback_streak INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
  )`,
  `CREATE INDEX idx_sessions_source ON sessions(source)`,
  `CREATE INDEX idx_sessions_source_id ON sessions(source, id)`,
  `CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)`,
  `CREATE INDEX idx_sessions_started ON sessions(started_at DESC)`,
  `CREATE INDEX idx_sessions_session_key
    ON sessions(session_key, started_at DESC)`,
  `CREATE INDEX idx_sessions_gateway_peer
    ON sessions(source, user_id, chat_id, chat_type, thread_id, started_at DESC)`,
  `CREATE INDEX idx_sessions_handoff_state
    ON sessions(handoff_state, started_at)`,
  `CREATE UNIQUE INDEX idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL`,
  `CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    effect_disposition TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_content TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT,
    codex_message_items TEXT,
    platform_message_id TEXT,
    observed INTEGER DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0
, "api_content" TEXT)`,
  `CREATE INDEX idx_messages_session ON messages(session_id, timestamp)`,
  `CREATE INDEX idx_messages_platform_msg_id ON messages(session_id, platform_message_id) WHERE platform_message_id IS NOT NULL`,
  `CREATE INDEX idx_messages_session_active
    ON messages(session_id, active, timestamp)`,
  `CREATE INDEX idx_messages_active_null
    ON messages(active) WHERE active IS NULL`,
  `CREATE VIRTUAL TABLE messages_fts USING fts5(content)`,
  `CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content, tokenize='trigram')`,
  `CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END`,
  `CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
END`,
  `CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END`,
  `CREATE TRIGGER messages_fts_trigram_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts_trigram(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END`,
  `CREATE TRIGGER messages_fts_trigram_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts_trigram WHERE rowid = old.id;
END`,
  `CREATE TRIGGER messages_fts_trigram_update AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts_trigram WHERE rowid = old.id;
    INSERT INTO messages_fts_trigram(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END`,
]

function openFreshDb(): Database {
  const db = new Database(dbPath, { create: true })
  for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run()
  return db
}

// Helpers accept millisecond instants and store REAL epoch seconds, so tests read
// back the same millisecond values the projection re-derives (`timestamp * 1000`).
function insertSession(
  db: Database,
  s: {
    id: string
    source?: string | null
    parentSessionId?: string | null
    title?: string | null
    archived?: number
    systemPrompt?: string | null
    model?: string | null
    modelConfig?: string | null
    userId?: string | null
    sessionKey?: string | null
    chatId?: string | null
    chatType?: string | null
    threadId?: string | null
    displayName?: string | null
    originJson?: string | null
    messageCount?: number
    toolCallCount?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    estimatedCostUsd?: number | null
    actualCostUsd?: number | null
    startedAt?: number
    endedAt?: number | null
    endReason?: string | null
    cwd?: string | null
    gitBranch?: string | null
    gitRepoRoot?: string | null
    billingProvider?: string | null
    billingBaseUrl?: string | null
    billingMode?: string | null
    costStatus?: string | null
    costSource?: string | null
    pricingVersion?: string | null
    apiCallCount?: number
    profileName?: string | null
    rewindCount?: number
    expiryFinalized?: number
  },
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, source, parent_session_id, title, archived,
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
        estimated_cost_usd, actual_cost_usd)
     VALUES ($id, $source, $parent, $title, $archived,
        $systemPrompt, $model, $modelConfig,
        $userId, $sessionKey, $chatId, $chatType, $threadId, $displayName,
        $originJson, $startedAt, $endedAt, $endReason,
        $cwd, $gitBranch, $gitRepoRoot,
        $billingProvider, $billingBaseUrl, $billingMode,
        $costStatus, $costSource, $pricingVersion,
        $apiCallCount, $profileName, $rewindCount, $expiryFinalized,
        $messageCount, $toolCallCount,
        $inputTokens, $outputTokens, $cacheReadTokens,
        $cacheWriteTokens, $reasoningTokens,
        $estimatedCostUsd, $actualCostUsd)`,
  ).run({
    $id: s.id,
    $source: s.source === undefined ? 'discord' : s.source,
    $parent: s.parentSessionId ?? null,
    $title: s.title ?? null,
    $archived: s.archived ?? 0,
    $systemPrompt: s.systemPrompt ?? null,
    $model: s.model ?? null,
    $modelConfig: s.modelConfig ?? null,
    $userId: s.userId ?? null,
    $sessionKey: s.sessionKey ?? null,
    $chatId: s.chatId ?? null,
    $chatType: s.chatType ?? null,
    $threadId: s.threadId ?? null,
    $displayName: s.displayName ?? null,
    $originJson: s.originJson ?? null,
    $startedAt: (s.startedAt ?? 1_000) / 1000,
    $endedAt: s.endedAt == null ? null : s.endedAt / 1000,
    $endReason: s.endReason ?? null,
    $cwd: s.cwd ?? null,
    $gitBranch: s.gitBranch ?? null,
    $gitRepoRoot: s.gitRepoRoot ?? null,
    $billingProvider: s.billingProvider ?? null,
    $billingBaseUrl: s.billingBaseUrl ?? null,
    $billingMode: s.billingMode ?? null,
    $costStatus: s.costStatus ?? null,
    $costSource: s.costSource ?? null,
    $pricingVersion: s.pricingVersion ?? null,
    $apiCallCount: s.apiCallCount ?? 0,
    $profileName: s.profileName ?? null,
    $rewindCount: s.rewindCount ?? 0,
    $expiryFinalized: s.expiryFinalized ?? 0,
    $messageCount: s.messageCount ?? 0,
    $toolCallCount: s.toolCallCount ?? 0,
    $inputTokens: s.inputTokens ?? 0,
    $outputTokens: s.outputTokens ?? 0,
    $cacheReadTokens: s.cacheReadTokens ?? 0,
    $cacheWriteTokens: s.cacheWriteTokens ?? 0,
    $reasoningTokens: s.reasoningTokens ?? 0,
    $estimatedCostUsd: s.estimatedCostUsd ?? null,
    $actualCostUsd: s.actualCostUsd ?? null,
  })
}

function insertMessage(
  db: Database,
  m: {
    id: number
    sessionId: string
    role?: string
    content?: string | null
    active?: number
    compacted?: number
    reasoning?: string | null
    toolCallId?: string | null
    toolCalls?: string | null
    toolName?: string | null
    effectDisposition?: string | null
    tokenCount?: number | null
    finishReason?: string | null
    observed?: number
    createdAt: number
  },
): void {
  db.prepare(
    `INSERT INTO messages
       (id, session_id, role, content, active, compacted,
        reasoning, tool_call_id, tool_calls, tool_name,
        effect_disposition, token_count, finish_reason, observed, timestamp)
     VALUES ($id, $sessionId, $role, $content, $active, $compacted,
        $reasoning, $toolCallId, $toolCalls, $toolName,
        $effectDisposition, $tokenCount, $finishReason, $observed, $timestamp)`,
  ).run({
    $id: m.id,
    $sessionId: m.sessionId,
    $role: m.role ?? 'user',
    $content: m.content === undefined ? 'hello' : m.content,
    $active: m.active ?? 1,
    $compacted: m.compacted ?? 0,
    $reasoning: m.reasoning ?? null,
    $toolCallId: m.toolCallId ?? null,
    $toolCalls: m.toolCalls ?? null,
    $toolName: m.toolName ?? null,
    $effectDisposition: m.effectDisposition ?? null,
    $tokenCount: m.tokenCount ?? null,
    $finishReason: m.finishReason ?? null,
    $observed: m.observed ?? 0,
    $timestamp: m.createdAt / 1000,
  })
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
    insertSession(db, { id: 'ses_1', title: 'hi', startedAt: 5_000 })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_1',
      role: 'user',
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 2,
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
    expect(rows[1]?.id).toBe(1)
    expect(rows[2]?.id).toBe(2)
    db.close()
  })

  test('orders same-timestamp messages by insertion id, not JSON text', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 5_000 })
    // Two rows share a timestamp; id 10 sorts before id 9 as raw JSON text, so a
    // text tiebreak would place a tool result ahead of its call. Insertion id
    // (INTEGER AUTOINCREMENT) is the true order.
    insertMessage(db, { id: 9, sessionId: 'ses_1', createdAt: 6_000 })
    insertMessage(db, { id: 10, sessionId: 'ses_1', createdAt: 6_000 })

    const messages = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    ).filter((r) => r.type === 'message')

    expect(messages.map((m) => m.id)).toEqual([9, 10])
    db.close()
  })

  test('orders a tail copy carrying an old timestamp by its higher id', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 5_000 })
    // A compaction preserves a tail copy that keeps its OLD timestamp, inserted
    // after the newer summary row. A timestamp sort would drop the copy ahead of
    // the summary; insertion id keeps the archive window intact.
    insertMessage(db, { id: 1, sessionId: 'ses_1', createdAt: 5_000 })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_1',
      content: 'newer summary',
      createdAt: 9_000,
    })
    insertMessage(db, {
      id: 3,
      sessionId: 'ses_1',
      content: 'tail copy with old ts',
      createdAt: 6_000,
    })

    const messages = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    ).filter((r) => r.type === 'message')

    expect(messages.map((m) => m.id)).toEqual([1, 2, 3])
    db.close()
  })

  test('session header carries the latest message time for routing', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_1', createdAt: 6_000 })
    insertMessage(db, { id: 2, sessionId: 'ses_1', createdAt: 8_500 })

    const row = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))[0]
    expect(row?.latestMessageTime).toBe(8_500)
    db.close()
  })

  test('converts REAL epoch seconds to millisecond timestamps', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 1_753_000_000_000 })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_1',
      createdAt: 1_753_000_123_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    expect(rows[0]?.createdAt).toBe(1_753_000_000_000)
    expect(rows[1]?.createdAt).toBe(1_753_000_123_000)
    db.close()
  })

  test('excludes cron, webhook and subagent sources', () => {
    const db = openFreshDb()
    let msgId = 1
    for (const source of ['cron', 'webhook', 'subagent']) {
      insertSession(db, { id: `ses_${source}`, source, startedAt: 5_000 })
      insertMessage(db, {
        id: msgId,
        sessionId: `ses_${source}`,
        createdAt: 6_000,
      })
      msgId += 1
    }
    insertSession(db, { id: 'ses_human', source: 'cli', startedAt: 5_000 })
    insertMessage(db, {
      id: 99,
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
    insertSession(db, { id: 'ses_root', source: 'discord', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_root', createdAt: 6_000 })
    insertSession(db, {
      id: 'ses_branch',
      source: 'discord',
      parentSessionId: 'ses_root',
      startedAt: 6_000,
    })
    insertMessage(db, { id: 2, sessionId: 'ses_branch', createdAt: 7_000 })

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
    insertSession(db, { id: 'ses_root', source: 'cli', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_root', createdAt: 6_000 })
    insertSession(db, {
      id: 'ses_subagent',
      source: 'subagent',
      parentSessionId: 'ses_root',
      startedAt: 6_000,
    })
    insertMessage(db, { id: 2, sessionId: 'ses_subagent', createdAt: 7_000 })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    const ids = rows.filter((r) => r.type === 'session').map((r) => r.id)
    expect(ids).toEqual(['ses_root'])
    db.close()
  })

  test('selects an archived session and retains its archive and lineage', () => {
    const db = openFreshDb()
    insertSession(db, {
      id: 'ses_archived',
      source: 'discord',
      parentSessionId: 'ses_origin',
      archived: 1,
      startedAt: 5_000,
    })
    insertMessage(db, { id: 1, sessionId: 'ses_archived', createdAt: 6_000 })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    const session = rows.find((r) => r.type === 'session')
    expect(session?.id).toBe('ses_archived')
    expect(session?.archived).toBe(1)
    expect(session?.parentId).toBe('ses_origin')
    db.close()
  })

  test('marks a non-archived session with archived 0', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_live', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_live', createdAt: 6_000 })

    const row = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))[0]
    expect(row?.archived).toBe(0)
    expect(row?.parentId).toBeNull()
    db.close()
  })

  test('selects by latest message time inside the half-open window', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_at_since', startedAt: 100 })
    insertMessage(db, { id: 1, sessionId: 'ses_at_since', createdAt: 1_000 })
    insertSession(db, { id: 'ses_below', startedAt: 100 })
    insertMessage(db, { id: 2, sessionId: 'ses_below', createdAt: 999 })
    insertSession(db, { id: 'ses_at_until', startedAt: 100 })
    insertMessage(db, { id: 3, sessionId: 'ses_at_until', createdAt: 5_000 })

    const rows = parseRows(projectRows({ db, sinceMs: 1_000, untilMs: 5_000 }))

    const ids = rows.filter((r) => r.type === 'session').map((r) => r.id)
    expect(ids).toEqual(['ses_at_since'])
    db.close()
  })

  test('excludes sessions with no messages', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_empty', startedAt: 5_000 })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    expect(rows).toHaveLength(0)
    db.close()
  })

  test('retains full session metadata, assembling usage and platform objects', () => {
    const db = openFreshDb()
    insertSession(db, {
      id: 'ses_1',
      archived: 1,
      systemPrompt: 'You are Hermes.',
      model: 'llama-swap/big',
      modelConfig: JSON.stringify({ maxTokens: 4096, maxIterations: 50 }),
      userId: '787',
      chatId: '42',
      chatType: 'thread',
      threadId: '42',
      displayName: 'François Best',
      originJson: JSON.stringify({
        platform: 'discord',
        chatName: '47ng / #hermes-home',
        scopeId: '1342',
      }),
      inputTokens: 120,
      outputTokens: 340,
      estimatedCostUsd: 0.012,
      startedAt: 5_000,
    })
    insertMessage(db, { id: 1, sessionId: 'ses_1', createdAt: 6_000 })

    const session = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    )[0]

    expect(session?.parentId).toBeNull()
    expect(session?.archived).toBe(1)
    expect(session?.systemPrompt).toBe('You are Hermes.')
    expect(session?.model).toBe('llama-swap/big')
    expect(session?.modelConfig).toEqual({ maxTokens: 4096, maxIterations: 50 })
    expect(session?.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 340,
      estimatedCostUsd: 0.012,
    })
    // Platform carries only the discrete identity columns; the origin blob is
    // never merged in (an RFC-7396 merge could delete a discrete id).
    expect(session?.platform).toEqual({
      user_id: '787',
      session_key: null,
      chat_id: '42',
      chat_type: 'thread',
      thread_id: '42',
      display_name: 'François Best',
    })
    // The raw origin blob travels verbatim as its own field for the archive.
    expect(session?.originJson).toEqual({
      platform: 'discord',
      chatName: '47ng / #hermes-home',
      scopeId: '1342',
    })
    db.close()
  })

  test('keeps a malformed nested blob as its original string, never null', () => {
    const db = openFreshDb()
    insertSession(db, {
      id: 'ses_1',
      modelConfig: '{not valid json',
      originJson: 'not-json-at-all',
      startedAt: 5_000,
    })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_1',
      toolCalls: '[oops',
      createdAt: 6_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    const session = rows[0]
    const message = rows[1]

    expect(session?.modelConfig).toBe('{not valid json')
    expect(session?.originJson).toBe('not-json-at-all')
    expect(message?.toolCalls).toBe('[oops')
    db.close()
  })

  test('round-trips the full set of live session and message columns', () => {
    const db = openFreshDb()
    insertSession(db, {
      id: 'ses_1',
      startedAt: 5_000,
      endedAt: 9_000,
      endReason: 'idle_timeout',
      cwd: '/home/echo/project',
      gitBranch: 'feat/hermes',
      gitRepoRoot: '/home/echo/project',
      billingProvider: 'anthropic',
      billingBaseUrl: 'https://api.example.test',
      billingMode: 'metered',
      costStatus: 'final',
      costSource: 'provider',
      pricingVersion: '2026-07',
      apiCallCount: 7,
      profileName: 'default',
      rewindCount: 2,
      expiryFinalized: 1,
      sessionKey: 'sk_abc',
    })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_1',
      role: 'assistant',
      effectDisposition: 'applied',
      tokenCount: 42,
      finishReason: 'stop',
      observed: 1,
      createdAt: 6_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    const session = rows[0]
    const message = rows[1]

    expect(session?.endedAt).toBe(9_000)
    expect(session?.endReason).toBe('idle_timeout')
    expect(session?.cwd).toBe('/home/echo/project')
    expect(session?.gitBranch).toBe('feat/hermes')
    expect(session?.gitRepoRoot).toBe('/home/echo/project')
    expect(session?.billingProvider).toBe('anthropic')
    expect(session?.billingBaseUrl).toBe('https://api.example.test')
    expect(session?.billingMode).toBe('metered')
    expect(session?.costStatus).toBe('final')
    expect(session?.costSource).toBe('provider')
    expect(session?.pricingVersion).toBe('2026-07')
    expect(session?.apiCallCount).toBe(7)
    expect(session?.profileName).toBe('default')
    expect(session?.rewindCount).toBe(2)
    expect(session?.expiryFinalized).toBe(1)
    expect(session?.sessionKey).toBe('sk_abc')

    expect(message?.effectDisposition).toBe('applied')
    expect(message?.tokenCount).toBe(42)
    expect(message?.finishReason).toBe('stop')
    expect(message?.observed).toBe(1)
    db.close()
  })

  test('retains message reasoning and tool-call data', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 5_000 })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_1',
      role: 'assistant',
      content: null,
      reasoning: 'First I considered the alternatives...',
      toolCalls: JSON.stringify([
        {
          id: 'call_1',
          call_id: 'call_1',
          type: 'function',
          function: { name: 'terminal', arguments: '{"command":"ls"}' },
        },
      ]),
      createdAt: 6_000,
    })

    const message = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    )[1]

    expect(message?.reasoning).toBe('First I considered the alternatives...')
    expect(message?.content).toBeNull()
    expect(message?.toolCalls).toEqual([
      {
        id: 'call_1',
        call_id: 'call_1',
        type: 'function',
        function: { name: 'terminal', arguments: '{"command":"ls"}' },
      },
    ])
    db.close()
  })

  test('retains rewound (inactive) rows carrying their active state', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 5_000 })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_1',
      content: 'kept in the live conversation',
      active: 1,
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_1',
      content: 'withdrawn with /undo',
      active: 0,
      compacted: 0,
      createdAt: 7_000,
    })

    const messages = parseRows(
      projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }),
    ).filter((r) => r.type === 'message')

    expect(messages).toHaveLength(2)
    expect(messages[0]?.active).toBe(1)
    expect(messages[1]?.id).toBe(2)
    expect(messages[1]?.active).toBe(0)
    expect(messages[1]?.compacted).toBe(0)
    expect(messages[1]?.content).toBe('withdrawn with /undo')
    db.close()
  })

  test('retains compaction-archived rows, the summary row and live rows in order', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 5_000 })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_1',
      content: 'earlier question',
      active: 0,
      compacted: 1,
      createdAt: 6_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_1',
      role: 'user',
      content: SUMMARY_CONTENT,
      active: 1,
      compacted: 0,
      createdAt: 7_000,
    })
    insertMessage(db, {
      id: 3,
      sessionId: 'ses_1',
      content: 'follow-up question',
      createdAt: 8_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    const messages = rows.filter((r) => r.type === 'message')

    expect(messages.map((m) => m.id)).toEqual([1, 2, 3])
    expect(messages[0]?.compacted).toBe(1)
    expect(messages[1]?.content).toContain(COMPACTION_PREFIX)
    db.close()
  })

  test('emits null for missing optional metadata without inventing values', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_1', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_1', createdAt: 6_000 })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))
    const session = rows[0]
    const message = rows[1]

    expect(session?.systemPrompt).toBeNull()
    expect(session?.model).toBeNull()
    expect(session?.modelConfig).toBeNull()
    // Usage is always an object built from the discrete counters.
    expect(session?.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    expect(message?.active).toBe(1)
    expect(message?.compacted).toBe(0)
    expect(message?.reasoning).toBeNull()
    expect(message?.toolCalls).toBeNull()
    expect(message?.toolName).toBeNull()
    db.close()
  })
})

function logicalIds(rows: Record<string, unknown>[]): unknown[] {
  return rows.filter((r) => r.type === 'session').map((r) => r.logicalId)
}

function physicalIds(rows: Record<string, unknown>[]): unknown[] {
  return rows.filter((r) => r.type === 'session').map((r) => r.id)
}

describe('rotated continuation chains', () => {
  test('joins a continuation under its root as one logical session', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'discord', startedAt: 5_000 })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_root',
      content: 'first question',
      createdAt: 6_000,
    })
    insertSession(db, {
      id: 'ses_cont',
      source: 'discord',
      parentSessionId: 'ses_root',
      startedAt: 7_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_cont',
      role: 'user',
      content: SUMMARY_CONTENT,
      createdAt: 7_000,
    })
    insertMessage(db, {
      id: 3,
      sessionId: 'ses_cont',
      content: 'follow-up',
      createdAt: 8_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(physicalIds(rows)).toEqual(['ses_root', 'ses_cont'])
    expect(logicalIds(rows)).toEqual(['ses_root', 'ses_root'])

    expect(rows.map((r) => r.id)).toEqual(['ses_root', 1, 'ses_cont', 2, 3])
    const cont = rows.find((r) => r.id === 'ses_cont')
    expect(cont?.parentId).toBe('ses_root')
    db.close()
  })

  test('detects a continuation past a leading session_meta row', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'discord', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_root', createdAt: 6_000 })
    insertSession(db, {
      id: 'ses_cont',
      source: 'discord',
      parentSessionId: 'ses_root',
      startedAt: 7_000,
    })
    // A session_meta row leads the continuation and carries the earliest
    // timestamp, so detection on MIN(timestamp) would read the wrong row. The
    // first user turn (by insertion id) is the compaction summary.
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_cont',
      role: 'session_meta',
      content: '{"model":"big"}',
      createdAt: 6_500,
    })
    insertMessage(db, {
      id: 3,
      sessionId: 'ses_cont',
      role: 'user',
      content: SUMMARY_CONTENT,
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    expect(physicalIds(rows)).toEqual(['ses_root', 'ses_cont'])
    expect(logicalIds(rows)).toEqual(['ses_root', 'ses_root'])
    db.close()
  })

  test('joins several continuations in chain order', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'cli', startedAt: 1_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_root', createdAt: 1_500 })
    insertSession(db, {
      id: 'ses_c1',
      source: 'cli',
      parentSessionId: 'ses_root',
      startedAt: 2_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_c1',
      role: 'user',
      content: SUMMARY_CONTENT,
      createdAt: 2_000,
    })
    insertSession(db, {
      id: 'ses_c2',
      source: 'cli',
      parentSessionId: 'ses_c1',
      startedAt: 3_000,
    })
    insertMessage(db, {
      id: 3,
      sessionId: 'ses_c2',
      role: 'user',
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
    insertSession(db, { id: 'ses_root', source: 'discord', startedAt: 100 })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_root',
      content: 'old question',
      createdAt: 500,
    })
    insertSession(db, {
      id: 'ses_cont',
      source: 'discord',
      parentSessionId: 'ses_root',
      startedAt: 5_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_cont',
      role: 'user',
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
    insertSession(db, { id: 'ses_root', source: 'discord', startedAt: 100 })
    insertMessage(db, { id: 1, sessionId: 'ses_root', createdAt: 500 })
    insertSession(db, {
      id: 'ses_cont',
      source: 'discord',
      parentSessionId: 'ses_root',
      startedAt: 9_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_cont',
      role: 'user',
      content: SUMMARY_CONTENT,
      createdAt: 9_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 1_000, untilMs: 5_000 }))
    expect(rows).toHaveLength(0)
    db.close()
  })

  test('does not join a user branch that opens with an ordinary turn', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'discord', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_root', createdAt: 6_000 })
    insertSession(db, {
      id: 'ses_branch',
      source: 'discord',
      parentSessionId: 'ses_root',
      startedAt: 6_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_branch',
      content: 'a fresh human question',
      createdAt: 7_000,
    })

    const rows = parseRows(projectRows({ db, sinceMs: 0, untilMs: UNTIL_MS }))

    const ids = logicalIds(rows)
    expect(ids).toHaveLength(2)
    expect(ids).toContain('ses_root')
    expect(ids).toContain('ses_branch')
    db.close()
  })

  test('does not join a subagent that opens with a compaction-like message', () => {
    const db = openFreshDb()
    insertSession(db, { id: 'ses_root', source: 'cli', startedAt: 5_000 })
    insertMessage(db, { id: 1, sessionId: 'ses_root', createdAt: 6_000 })
    insertSession(db, {
      id: 'ses_sub',
      source: 'subagent',
      parentSessionId: 'ses_root',
      startedAt: 6_000,
    })
    insertMessage(db, {
      id: 2,
      sessionId: 'ses_sub',
      role: 'user',
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
    insertSession(db, {
      id: 'ses_orphan',
      source: 'discord',
      parentSessionId: 'ses_missing',
      startedAt: 5_000,
    })
    insertMessage(db, {
      id: 1,
      sessionId: 'ses_orphan',
      role: 'user',
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

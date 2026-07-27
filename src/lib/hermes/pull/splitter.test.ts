import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { splitJsonlToSessionFiles } from './splitter.ts'

const DAY1_MS = Date.UTC(2026, 4, 9, 12, 0, 0)
const DAY2_MS = Date.UTC(2026, 4, 10, 8, 0, 0)
const DAY1 = '2026-05-09'
const DAY2 = '2026-05-10'

let workDir: string
let dataDir: string

async function* fromArray(lines: ReadonlyArray<string>): AsyncIterable<string> {
  for (const line of lines) yield line
}

function messageLine(fields: {
  id: string
  sessionId: string
  logicalId?: string
}): string {
  return JSON.stringify({
    type: 'message',
    role: 'user',
    content: 'hi',
    createdAt: DAY1_MS,
    ...fields,
  })
}

function bucket(day: string): string {
  return path.join(dataDir, day, 'echo', 'hermes')
}

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-hermes-splitter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  dataDir = path.join(workDir, 'data')
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('splitJsonlToSessionFiles', () => {
  test('routes each session to its latest-message UTC day and counts rows', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        latestMessageTime: DAY1_MS,
      }),
      messageLine({ id: 'msg_a1', sessionId: 'ses_a' }),
      messageLine({ id: 'msg_a2', sessionId: 'ses_a' }),
      JSON.stringify({
        type: 'session',
        id: 'ses_b',
        sessionId: 'ses_b',
        latestMessageTime: DAY2_MS,
      }),
      messageLine({ id: 'msg_b1', sessionId: 'ses_b' }),
    ]

    const metrics = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    })
    await metrics.commit()

    expect(readdirSync(bucket(DAY1)).sort()).toEqual(['ses_a.jsonl'])
    expect(readdirSync(bucket(DAY2)).sort()).toEqual(['ses_b.jsonl'])
    expect(metrics.sessions_pulled).toBe(2)
    expect(metrics.messages_pulled).toBe(3)
    expect(metrics.bytes).toBeGreaterThan(0)
    expect(metrics.sessionPaths).toHaveLength(2)

    const content = readFileSync(
      path.join(bucket(DAY1), 'ses_a.jsonl'),
      'utf-8',
    )
    expect(content.trim().split('\n')).toHaveLength(3)
  })

  test('joins a rotated chain into one file named for the root uuid', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: 'ses_root',
        sessionId: 'ses_root',
        logicalId: 'ses_root',
        latestMessageTime: DAY2_MS,
      }),
      messageLine({
        id: 'msg_root',
        sessionId: 'ses_root',
        logicalId: 'ses_root',
      }),
      JSON.stringify({
        type: 'session',
        id: 'ses_cont',
        sessionId: 'ses_cont',
        logicalId: 'ses_root',
        latestMessageTime: DAY2_MS,
      }),
      messageLine({
        id: 'msg_cont',
        sessionId: 'ses_cont',
        logicalId: 'ses_root',
      }),
    ]

    const metrics = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    })
    await metrics.commit()

    // One file, named for the root, routed by the logical latest message.
    expect(readdirSync(bucket(DAY2)).sort()).toEqual(['ses_root.jsonl'])
    // The joined session counts once; both physical members' rows are kept.
    expect(metrics.sessions_pulled).toBe(1)
    expect(metrics.messages_pulled).toBe(2)
    expect(metrics.sessionPaths).toHaveLength(1)

    const content = readFileSync(
      path.join(bucket(DAY2), 'ses_root.jsonl'),
      'utf-8',
    )
    expect(content.trim().split('\n')).toHaveLength(4)
    expect(content).toContain('"id":"ses_cont"')
  })

  test('fails with source context on a malformed row', async () => {
    const lines = [
      JSON.stringify({ type: 'session', sessionId: 'ses_a' }), // missing latestMessageTime
    ]
    const result = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('hermes/echo')
  })

  test('accepts a message row with null content (tool-only row)', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        latestMessageTime: DAY1_MS,
      }),
      // An assistant row carrying only tool_calls, or a tool result row whose
      // payload lives in api_content, legitimately stores no text.
      `{"type":"message","id":1,"sessionId":"ses_a","role":"assistant","content":null,"createdAt":${DAY1_MS}}`,
    ]
    const metrics = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    })
    await metrics.commit()

    expect(metrics.messages_pulled).toBe(1)
    const content = readFileSync(
      path.join(bucket(DAY1), 'ses_a.jsonl'),
      'utf-8',
    )
    expect(content).toContain('"content":null')
  })

  test('fails with source context on a message row with null createdAt', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        latestMessageTime: DAY1_MS,
      }),
      `{"type":"message","id":"m","sessionId":"ses_a","role":"user","content":"hi","createdAt":null}`,
    ]
    const result = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('hermes/echo')
  })

  test('wraps a truncated json line in a tagged source error', async () => {
    const lines = ['{"type":"session","sessionId":"ses_a","latestMess']
    const result = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('hermes/echo')
    expect(result.message).toContain('not valid JSON')
    expect(result.cause).toBeInstanceOf(SyntaxError)
  })

  test('fails when a message precedes its session header', async () => {
    const lines = [
      JSON.stringify({ type: 'message', id: 'm', sessionId: 'orphan' }),
    ]
    const result = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('hermes/echo')
  })

  test('rejects a session id that would escape the day bucket', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: '../evil',
        sessionId: '../evil',
        latestMessageTime: DAY1_MS,
      }),
    ]
    const result = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('hermes/echo')
    expect(result.message).toContain('unsafe session id')
  })

  test('rejects a logical key that reappears after another session', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        latestMessageTime: DAY1_MS,
      }),
      messageLine({ id: 'm_a', sessionId: 'ses_a' }),
      JSON.stringify({
        type: 'session',
        id: 'ses_b',
        sessionId: 'ses_b',
        latestMessageTime: DAY2_MS,
      }),
      // ses_a reappears after ses_b: staging it again would clobber the first
      // ses_a file at commit, so the stream is rejected.
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        latestMessageTime: DAY1_MS,
      }),
    ]
    const result = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('hermes/echo')
    expect(result.message).toContain('reappears')
    // The error is a tagged errore error carrying the machine, like
    // SshSourceFailure, rather than a bare Error.
    expect('_tag' in result).toBe(true)
    if ('_tag' in result) expect(result._tag).toBe('HermesRowInvalid')
    expect('machine' in result).toBe(true)
    if ('machine' in result) expect(result.machine).toBe('echo')
  })

  test('stages files and writes none until commit is called', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        latestMessageTime: DAY1_MS,
      }),
      messageLine({ id: 'msg_a1', sessionId: 'ses_a' }),
    ]
    const staged = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    })

    // The stream validated but nothing is on disk yet.
    expect(existsSync(bucket(DAY1))).toBe(false)
    await staged.commit()
    expect(readdirSync(bucket(DAY1)).sort()).toEqual(['ses_a.jsonl'])
  })

  test('leaves no final file when a late row is malformed', async () => {
    const lines = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        latestMessageTime: DAY1_MS,
      }),
      messageLine({ id: 'msg_a1', sessionId: 'ses_a' }),
      '{"type":"message","id":"m2","sessionId":"ses_a","role":"user","content":"hi","createdAt":null}',
    ]
    const result = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    // The malformed row aborts the stream before commit, so no partial file
    // survives from the rows that did validate.
    expect(existsSync(bucket(DAY1))).toBe(false)
  })
})

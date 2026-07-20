import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
      JSON.stringify({ type: 'message', id: 'msg_a1', sessionId: 'ses_a' }),
      JSON.stringify({ type: 'message', id: 'msg_a2', sessionId: 'ses_a' }),
      JSON.stringify({
        type: 'session',
        id: 'ses_b',
        sessionId: 'ses_b',
        latestMessageTime: DAY2_MS,
      }),
      JSON.stringify({ type: 'message', id: 'msg_b1', sessionId: 'ses_b' }),
    ]

    const metrics = await splitJsonlToSessionFiles({
      lines: fromArray(lines),
      dataDir,
      machine: 'echo',
    })

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
      JSON.stringify({
        type: 'message',
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
      JSON.stringify({
        type: 'message',
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
})

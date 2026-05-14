import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { splitJsonlToSessionFiles } from './splitter.ts'

let dataDir: string

async function* fromLines(lines: ReadonlyArray<string>): AsyncIterable<string> {
  for (const line of lines) yield line
}

// 2026-05-09T12:00:00Z and 2026-05-10T08:00:00Z — distinct UTC days.
const DAY1_MS = Date.UTC(2026, 4, 9, 12, 0, 0)
const DAY2_MS = Date.UTC(2026, 4, 10, 8, 0, 0)
const DAY1 = '2026-05-09'
const DAY2 = '2026-05-10'

function bucket(day: string): string {
  return path.join(dataDir, day, 'm4x', 'opencode')
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const next = path.join(d, entry.name)
      const nextRel = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) walk(next, nextRel)
      else out.push(nextRel)
    }
  }
  walk(dir, '')
  return out.sort()
}

beforeEach(() => {
  dataDir = path.join(
    tmpdir(),
    `dream-opencode-splitter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('splitJsonlToSessionFiles', () => {
  test('writes a single session file containing all its rows', async () => {
    const rows = [
      JSON.stringify({
        type: 'session',
        id: 'ses_1',
        sessionId: 'ses_1',
        time_updated: DAY1_MS,
      }),
      JSON.stringify({
        type: 'message',
        id: 'msg_1',
        sessionId: 'ses_1',
        role: 'user',
      }),
    ]

    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines(rows),
      dataDir,
      machine: 'm4x',
    })

    expect(listFiles(dataDir)).toEqual([`${DAY1}/m4x/opencode/ses_1.jsonl`])
    const content = readFileSync(
      path.join(bucket(DAY1), 'ses_1.jsonl'),
      'utf-8',
    )
    expect(content).toBe(rows[0] + '\n' + rows[1] + '\n')
    expect(metrics.sessions_pulled).toBe(1)
    expect(metrics.messages_pulled).toBe(1)
    expect(metrics.parts_pulled).toBe(0)
  })

  test('routes each session to the UTC day of its time_updated', async () => {
    const rows = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        time_updated: DAY1_MS,
      }),
      JSON.stringify({ type: 'message', id: 'msg_a', sessionId: 'ses_a' }),
      JSON.stringify({
        type: 'session',
        id: 'ses_b',
        sessionId: 'ses_b',
        time_updated: DAY2_MS,
      }),
      JSON.stringify({ type: 'part', id: 'prt_b', sessionId: 'ses_b' }),
    ]

    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines(rows),
      dataDir,
      machine: 'm4x',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/m4x/opencode/ses_a.jsonl`,
      `${DAY2}/m4x/opencode/ses_b.jsonl`,
    ])
    expect(readFileSync(path.join(bucket(DAY1), 'ses_a.jsonl'), 'utf-8')).toBe(
      rows[0] + '\n' + rows[1] + '\n',
    )
    expect(readFileSync(path.join(bucket(DAY2), 'ses_b.jsonl'), 'utf-8')).toBe(
      rows[2] + '\n' + rows[3] + '\n',
    )
    expect(metrics.sessions_pulled).toBe(2)
    expect(metrics.messages_pulled).toBe(1)
    expect(metrics.parts_pulled).toBe(1)
  })

  test('returns zero metrics on empty stream', async () => {
    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines([]),
      dataDir,
      machine: 'm4x',
    })
    expect(readdirSync(dataDir)).toEqual([])
    expect(metrics).toEqual({
      sessions_pulled: 0,
      messages_pulled: 0,
      parts_pulled: 0,
      bytes: 0,
    })
  })

  test('skips empty lines', async () => {
    const rows = [
      JSON.stringify({
        type: 'session',
        id: 'ses_a',
        sessionId: 'ses_a',
        time_updated: DAY1_MS,
      }),
      '',
      JSON.stringify({ type: 'message', id: 'msg_a', sessionId: 'ses_a' }),
    ]
    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines(rows),
      dataDir,
      machine: 'm4x',
    })
    expect(metrics.sessions_pulled).toBe(1)
    expect(metrics.messages_pulled).toBe(1)
  })

  test('bytes metric counts every written byte including newlines', async () => {
    const row = JSON.stringify({
      type: 'session',
      id: 'ses_1',
      sessionId: 'ses_1',
      time_updated: DAY1_MS,
    })
    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines([row]),
      dataDir,
      machine: 'm4x',
    })
    expect(metrics.bytes).toBe(Buffer.byteLength(row + '\n'))
  })
})

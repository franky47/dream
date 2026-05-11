import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { splitJsonlToSessionFiles } from './splitter.ts'

let outDir: string

async function* fromLines(lines: ReadonlyArray<string>): AsyncIterable<string> {
  for (const line of lines) yield line
}

beforeEach(() => {
  outDir = path.join(
    tmpdir(),
    `dream-opencode-splitter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(outDir, { recursive: true })
})

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true })
})

describe('splitJsonlToSessionFiles', () => {
  test('writes a single session file containing all its rows', async () => {
    const rows = [
      JSON.stringify({ type: 'session', id: 'ses_1', sessionId: 'ses_1' }),
      JSON.stringify({
        type: 'message',
        id: 'msg_1',
        sessionId: 'ses_1',
        role: 'user',
      }),
    ]

    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines(rows),
      outDir,
    })

    const files = readdirSync(outDir)
    expect(files).toEqual(['ses_1.jsonl'])
    const content = readFileSync(path.join(outDir, 'ses_1.jsonl'), 'utf-8')
    expect(content).toBe(rows[0] + '\n' + rows[1] + '\n')
    expect(metrics.sessions_pulled).toBe(1)
    expect(metrics.messages_pulled).toBe(1)
    expect(metrics.parts_pulled).toBe(0)
  })

  test('splits rows into separate files per sessionId', async () => {
    const rows = [
      JSON.stringify({ type: 'session', id: 'ses_a', sessionId: 'ses_a' }),
      JSON.stringify({ type: 'message', id: 'msg_a', sessionId: 'ses_a' }),
      JSON.stringify({ type: 'session', id: 'ses_b', sessionId: 'ses_b' }),
      JSON.stringify({ type: 'part', id: 'prt_b', sessionId: 'ses_b' }),
    ]

    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines(rows),
      outDir,
    })

    const files = readdirSync(outDir).sort()
    expect(files).toEqual(['ses_a.jsonl', 'ses_b.jsonl'])
    expect(readFileSync(path.join(outDir, 'ses_a.jsonl'), 'utf-8')).toBe(
      rows[0] + '\n' + rows[1] + '\n',
    )
    expect(readFileSync(path.join(outDir, 'ses_b.jsonl'), 'utf-8')).toBe(
      rows[2] + '\n' + rows[3] + '\n',
    )
    expect(metrics.sessions_pulled).toBe(2)
    expect(metrics.messages_pulled).toBe(1)
    expect(metrics.parts_pulled).toBe(1)
  })

  test('returns zero metrics on empty stream', async () => {
    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines([]),
      outDir,
    })
    expect(readdirSync(outDir)).toEqual([])
    expect(metrics).toEqual({
      sessions_pulled: 0,
      messages_pulled: 0,
      parts_pulled: 0,
      bytes: 0,
    })
  })

  test('skips empty lines', async () => {
    const rows = [
      JSON.stringify({ type: 'session', id: 'ses_a', sessionId: 'ses_a' }),
      '',
      JSON.stringify({ type: 'message', id: 'msg_a', sessionId: 'ses_a' }),
    ]
    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines(rows),
      outDir,
    })
    expect(metrics.sessions_pulled).toBe(1)
    expect(metrics.messages_pulled).toBe(1)
  })

  test('bytes metric counts every written byte including newlines', async () => {
    const row = JSON.stringify({
      type: 'session',
      id: 'ses_1',
      sessionId: 'ses_1',
    })
    const metrics = await splitJsonlToSessionFiles({
      lines: fromLines([row]),
      outDir,
    })
    expect(metrics.bytes).toBe(Buffer.byteLength(row + '\n'))
  })
})

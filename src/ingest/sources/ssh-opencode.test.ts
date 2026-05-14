import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildRemoteCmd,
  ingestSshOpencode,
  runSshOpencodePipeline,
} from '#src/ingest/sources/ssh-opencode'

let workDir: string
let dataDir: string

// 2026-05-09T12:00:00Z and 2026-05-10T08:00:00Z — distinct UTC days.
const DAY1_MS = Date.UTC(2026, 4, 9, 12, 0, 0)
const DAY2_MS = Date.UTC(2026, 4, 10, 8, 0, 0)
const DAY1 = '2026-05-09'
const DAY2 = '2026-05-10'

function bucket(day: string): string {
  return path.join(dataDir, day, 'fake', 'opencode')
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
  workDir = path.join(
    tmpdir(),
    `dream-ssh-opencode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  dataDir = path.join(workDir, 'data')
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('ingestSshOpencode', () => {
  test('uses host as both ssh target and machine label', () => {
    const src = ingestSshOpencode({ host: 'hex' })
    expect(src.machine).toBe('hex')
    expect(src.source).toBe('opencode')
  })
})

describe('buildRemoteCmd', () => {
  test('invokes sqlite3 -readonly against the default opencode db path', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 1_700_000_000_000,
      untilMs: 1_800_000_000_000,
    })
    expect(cmd).toContain('sqlite3 -readonly')
    expect(cmd).toContain('.local/share/opencode/opencode.db')
  })

  test('inlines sinceMs and untilMs literals into the embedded SQL', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 1_700_000_000_000,
      untilMs: 1_800_000_000_000,
    })
    expect(cmd).toContain('1700000000000')
    expect(cmd).toContain('1800000000000')
  })

  test('honours a custom dbPath', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 0,
      untilMs: 1_800_000_000_000,
      dbPath: '/var/lib/opencode/opencode.db',
    })
    expect(cmd).toContain('/var/lib/opencode/opencode.db')
  })

  test('shell-quotes the SQL so embedded single quotes survive the remote shell', () => {
    const cmd = buildRemoteCmd({ sinceMs: 0, untilMs: 1_800_000_000_000 })
    // The projection SQL contains plenty of single-quoted JSON keys like
    // 'type', 'sessionId', etc. The shell-quoted form must use the
    // POSIX `'\''` trick rather than leaving raw single quotes naked.
    expect(cmd).toContain(`'\\''`)
  })
})

describe('runSshOpencodePipeline', () => {
  test('splits a jsonl stdout stream into per-day session files', async () => {
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    const content =
      [
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
      ].join('\n') + '\n'
    writeFileSync(fixturePath, content)

    const result = await runSshOpencodePipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'fake',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/fake/opencode/ses_a.jsonl`,
      `${DAY2}/fake/opencode/ses_b.jsonl`,
    ])
    expect(result.sessions_pulled).toBe(2)
    expect(result.messages_pulled).toBe(1)
    expect(result.parts_pulled).toBe(0)
    expect(
      readFileSync(path.join(bucket(DAY1), 'ses_a.jsonl'), 'utf-8'),
    ).toContain('"id":"msg_a"')
  })

  test('handles an empty stdout (no recent sessions) as success', async () => {
    const result = await runSshOpencodePipeline({
      upstream: ['sh', '-c', 'true'],
      dataDir,
      host: 'fake',
    })
    expect(result).toEqual({
      sessions_pulled: 0,
      messages_pulled: 0,
      parts_pulled: 0,
      bytes: 0,
    })
  })

  test('throws SshSourceFailure when upstream exits non-zero', async () => {
    const result = await runSshOpencodePipeline({
      upstream: ['sh', '-c', 'echo "ssh: Could not resolve" >&2; exit 255'],
      dataDir,
      host: 'invalid.example',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('host=invalid.example')
    expect(result.message).toContain('ssh=255')
    expect(result.message).toContain('Could not resolve')
  })
})

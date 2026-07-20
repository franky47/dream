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
  ingestSshHermes,
  runSshHermesPipeline,
} from '#src/ingest/sources/ssh-hermes'

let workDir: string
let dataDir: string

const DAY1_MS = Date.UTC(2026, 4, 9, 12, 0, 0)
const DAY2_MS = Date.UTC(2026, 4, 10, 8, 0, 0)
const DAY1 = '2026-05-09'
const DAY2 = '2026-05-10'

function bucket(day: string): string {
  return path.join(dataDir, day, 'echo', 'hermes')
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
    `dream-ssh-hermes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  dataDir = path.join(workDir, 'data')
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('ingestSshHermes', () => {
  test('uses host as both ssh target and machine label', () => {
    const src = ingestSshHermes({ host: 'echo' })
    expect(src.machine).toBe('echo')
    expect(src.source).toBe('hermes')
  })
})

describe('buildRemoteCmd', () => {
  test('invokes sqlite3 -readonly against the default hermes state db path', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 1_700_000_000_000,
      untilMs: 1_800_000_000_000,
    })
    expect(cmd).toContain('sqlite3 -readonly')
    expect(cmd).toContain('.hermes/state.db')
  })

  test('leaves the default $HOME db path unquoted so the remote shell expands it', () => {
    const cmd = buildRemoteCmd({ sinceMs: 0, untilMs: 1_800_000_000_000 })
    expect(cmd).toContain('sqlite3 -readonly $HOME/.hermes/state.db ')
    expect(cmd).not.toContain(`'$HOME/.hermes/state.db'`)
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
      dbPath: '/var/lib/hermes/state.db',
    })
    expect(cmd).toContain('/var/lib/hermes/state.db')
  })

  test('shell-quotes the SQL so embedded single quotes survive the remote shell', () => {
    const cmd = buildRemoteCmd({ sinceMs: 0, untilMs: 1_800_000_000_000 })
    expect(cmd).toContain(`'\\''`)
  })
})

describe('runSshHermesPipeline', () => {
  function sessionLine(id: string, latestMessageTime: number): string {
    return JSON.stringify({
      type: 'session',
      id,
      sessionId: id,
      source: 'discord',
      title: id,
      createdAt: latestMessageTime,
      latestMessageTime,
    })
  }

  function messageLine(id: string, sessionId: string, ts: number): string {
    return JSON.stringify({
      type: 'message',
      id,
      sessionId,
      turn: 1,
      role: 'user',
      content: 'hi',
      createdAt: ts,
    })
  }

  test('splits a jsonl stdout stream into per-day session files with md siblings', async () => {
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    const content =
      [
        sessionLine('ses_a', DAY1_MS),
        messageLine('msg_a', 'ses_a', DAY1_MS),
        sessionLine('ses_b', DAY2_MS),
        messageLine('msg_b', 'ses_b', DAY2_MS),
      ].join('\n') + '\n'
    writeFileSync(fixturePath, content)

    const result = await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/ses_a.jsonl`,
      `${DAY1}/echo/hermes/ses_a.md`,
      `${DAY2}/echo/hermes/ses_b.jsonl`,
      `${DAY2}/echo/hermes/ses_b.md`,
    ])
    expect(result.sessions_pulled).toBe(2)
    expect(result.messages_pulled).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(
      readFileSync(path.join(bucket(DAY1), 'ses_a.md'), 'utf-8'),
    ).toContain('sessionId: ses_a')
  })

  test('renders a compacted session as numbered context-window fragments', async () => {
    const summary =
      'Safety prefix the reader never sees.\n\n' +
      '[hermes:compaction-summary]\nWe planned the refactor.\n' +
      '[/hermes:compaction-summary]'
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_c', DAY1_MS),
        messageLine('m1', 'ses_c', DAY1_MS),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          sessionId: 'ses_c',
          turn: 2,
          role: 'assistant',
          content: summary,
          activity: 'active',
          createdAt: DAY1_MS + 1_000,
        }),
        messageLine('m3', 'ses_c', DAY1_MS + 2_000),
      ].join('\n') + '\n',
    )

    await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/ses_c.1.md`,
      `${DAY1}/echo/hermes/ses_c.2.md`,
      `${DAY1}/echo/hermes/ses_c.jsonl`,
    ])
    const two = readFileSync(path.join(bucket(DAY1), 'ses_c.2.md'), 'utf-8')
    expect(two).toContain('<compaction')
    expect(two).toContain('We planned the refactor.')
    expect(two).not.toContain('Safety prefix')
  })

  test('leaves snapshots in unrelated day buckets untouched', async () => {
    const priorDir = path.join(dataDir, '2026-05-01', 'echo', 'hermes')
    mkdirSync(priorDir, { recursive: true })
    const priorFile = path.join(priorDir, 'ses_old.jsonl')
    writeFileSync(priorFile, 'kept\n')

    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_a', DAY1_MS),
        messageLine('msg_a', 'ses_a', DAY1_MS),
      ].join('\n') + '\n',
    )

    await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(readFileSync(priorFile, 'utf-8')).toBe('kept\n')
  })

  test('handles an empty stdout (no recent sessions) as success', async () => {
    const result = await runSshHermesPipeline({
      upstream: ['sh', '-c', 'true'],
      dataDir,
      host: 'echo',
    })
    expect(result).toEqual({
      sessions_pulled: 0,
      messages_pulled: 0,
      bytes: 0,
    })
  })

  test('throws SshSourceFailure when upstream exits non-zero', async () => {
    const result = await runSshHermesPipeline({
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

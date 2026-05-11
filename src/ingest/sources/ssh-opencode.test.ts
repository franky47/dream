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
let outDir: string

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-ssh-opencode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  outDir = path.join(workDir, 'out')
  mkdirSync(outDir, { recursive: true })
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
    const cmd = buildRemoteCmd({ sinceMs: 1_700_000_000_000 })
    expect(cmd).toContain('sqlite3 -readonly')
    expect(cmd).toContain('.local/share/opencode/opencode.db')
  })

  test('inlines sinceMs literal into the embedded SQL', () => {
    const cmd = buildRemoteCmd({ sinceMs: 1_700_000_000_000 })
    expect(cmd).toContain('1700000000000')
  })

  test('honours a custom dbPath', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 0,
      dbPath: '/var/lib/opencode/opencode.db',
    })
    expect(cmd).toContain('/var/lib/opencode/opencode.db')
  })

  test('shell-quotes the SQL so embedded single quotes survive the remote shell', () => {
    const cmd = buildRemoteCmd({ sinceMs: 0 })
    // The projection SQL contains plenty of single-quoted JSON keys like
    // 'type', 'sessionId', etc. The shell-quoted form must use the
    // POSIX `'\''` trick rather than leaving raw single quotes naked.
    expect(cmd).toContain(`'\\''`)
  })
})

describe('runSshOpencodePipeline', () => {
  test('splits a jsonl stdout stream into per-session files', async () => {
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    const content =
      [
        JSON.stringify({ type: 'session', id: 'ses_a', sessionId: 'ses_a' }),
        JSON.stringify({ type: 'message', id: 'msg_a', sessionId: 'ses_a' }),
        JSON.stringify({ type: 'session', id: 'ses_b', sessionId: 'ses_b' }),
      ].join('\n') + '\n'
    writeFileSync(fixturePath, content)

    const result = await runSshOpencodePipeline({
      upstream: ['cat', fixturePath],
      outDir,
      host: 'fake',
    })

    expect(readdirSync(outDir).sort()).toEqual(['ses_a.jsonl', 'ses_b.jsonl'])
    expect(result.sessions_pulled).toBe(2)
    expect(result.messages_pulled).toBe(1)
    expect(result.parts_pulled).toBe(0)
    expect(readFileSync(path.join(outDir, 'ses_a.jsonl'), 'utf-8')).toContain(
      '"id":"msg_a"',
    )
  })

  test('handles an empty stdout (no recent sessions) as success', async () => {
    const result = await runSshOpencodePipeline({
      upstream: ['sh', '-c', 'true'],
      outDir,
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
      outDir,
      host: 'invalid.example',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('host=invalid.example')
    expect(result.message).toContain('ssh=255')
    expect(result.message).toContain('Could not resolve')
  })
})

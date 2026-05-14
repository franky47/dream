import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildRemoteCmd,
  ingestSshClaude,
  runSshTarPipeline,
} from '#src/ingest/sources/ssh-claude'

let workDir: string
let dataDir: string
let fixtureDir: string

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-ssh-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  dataDir = path.join(workDir, 'data')
  fixtureDir = path.join(workDir, 'fixture')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(fixtureDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const SINCE = new Date('2026-05-08T00:00:00.000Z')
const UNTIL = new Date('2026-05-10T00:00:00.000Z')
const IN_WINDOW = new Date('2026-05-09T12:00:00.000Z')
const AFTER_WINDOW = new Date('2026-05-11T12:00:00.000Z')
const BUCKET = '2026-05-09/fake/claude'

function writeFixture(relPath: string, content: string, mtime: Date): void {
  const full = path.join(fixtureDir, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
  utimesSync(full, mtime, mtime)
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

const tarFixture = (): string[] => ['sh', '-c', `tar -czf - -C ${fixtureDir} .`]

describe('ingestSshClaude', () => {
  test('uses host as both ssh target and machine label', () => {
    const src = ingestSshClaude({ host: 'echo' })
    expect(src.machine).toBe('echo')
    expect(src.source).toBe('claude')
  })
})

describe('buildRemoteCmd', () => {
  test('matches in-window jsonl and memory/*.md, excluding subagent jsonl', () => {
    const cmd = buildRemoteCmd(new Date('2026-05-08T00:00:00.000Z'))
    expect(cmd).toContain("-newermt '2026-05-08 00:00:00 UTC'")
    expect(cmd).toContain("-name '*.jsonl'")
    expect(cmd).toContain("-not -path '*/subagents/*'")
    expect(cmd).toContain("-path '*/memory/*.md'")
    expect(cmd).toContain('tar --null -czf - -T -')
  })
})

describe('runSshTarPipeline', () => {
  test('extracts a tar stream and routes files into mtime day-buckets', async () => {
    writeFixture(
      '-Users-franky-projA/aaa.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )
    writeFixture(
      '-Users-franky-projB/bbb.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )

    const result = await runSshTarPipeline({
      upstream: tarFixture(),
      dataDir,
      host: 'fake',
      since: SINCE,
      until: UNTIL,
    })

    expect(
      listFiles(dataDir).filter((f) => !path.basename(f).startsWith('.')),
    ).toEqual([
      `${BUCKET}/-Users-franky-projA/aaa.jsonl`,
      `${BUCKET}/-Users-franky-projA/aaa.md`,
      `${BUCKET}/-Users-franky-projB/bbb.jsonl`,
      `${BUCKET}/-Users-franky-projB/bbb.md`,
    ])
    expect(result).toEqual({
      sessions_pulled: 2,
      memories_pulled: 0,
      bytes: 32,
    })
    expect(
      readFileSync(
        path.join(dataDir, `${BUCKET}/-Users-franky-projA/aaa.jsonl`),
        'utf-8',
      ),
    ).toBe('{"type":"user"}\n')
  })

  test('post-filters files whose mtime is at or after until', async () => {
    writeFixture(
      '-Users-franky-projA/aaa.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )
    writeFixture(
      '-Users-franky-projA/ccc.jsonl',
      '{"type":"user"}\n',
      AFTER_WINDOW,
    )

    const result = await runSshTarPipeline({
      upstream: tarFixture(),
      dataDir,
      host: 'fake',
      since: SINCE,
      until: UNTIL,
    })

    expect(
      listFiles(dataDir).filter((f) => !path.basename(f).startsWith('.')),
    ).toEqual([
      `${BUCKET}/-Users-franky-projA/aaa.jsonl`,
      `${BUCKET}/-Users-franky-projA/aaa.md`,
    ])
    expect(result.sessions_pulled).toBe(1)
  })

  test('splits sessions vs memories in metrics when extracting a mixed payload', async () => {
    writeFixture(
      '-Users-franky-projA/aaa.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )
    writeFixture(
      '-Users-franky-projA/memory/feedback_x.md',
      'memo body\n',
      IN_WINDOW,
    )
    writeFixture('-Users-franky-projA/memory/MEMORY.md', '- index\n', IN_WINDOW)

    const result = await runSshTarPipeline({
      upstream: tarFixture(),
      dataDir,
      host: 'fake',
      since: SINCE,
      until: UNTIL,
    })

    expect(
      listFiles(dataDir).filter((f) => !path.basename(f).startsWith('.')),
    ).toEqual([
      `${BUCKET}/-Users-franky-projA/aaa.jsonl`,
      `${BUCKET}/-Users-franky-projA/aaa.md`,
      `${BUCKET}/-Users-franky-projA/memory/MEMORY.md`,
      `${BUCKET}/-Users-franky-projA/memory/feedback_x.md`,
    ])
    expect(result.sessions_pulled).toBe(1)
    expect(result.memories_pulled).toBe(2)
  })

  test('handles an empty tar (no files matched on remote) as success', async () => {
    const result = await runSshTarPipeline({
      upstream: ['sh', '-c', `tar -czf - -T /dev/null`],
      dataDir,
      host: 'fake',
      since: SINCE,
      until: UNTIL,
    })
    expect(result).toEqual({
      sessions_pulled: 0,
      memories_pulled: 0,
      bytes: 0,
    })
  })

  test('throws SshSourceFailure when upstream exits non-zero', async () => {
    const result = await runSshTarPipeline({
      upstream: ['sh', '-c', 'echo "ssh: Could not resolve" >&2; exit 255'],
      dataDir,
      host: 'invalid.example',
      since: SINCE,
      until: UNTIL,
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('host=invalid.example')
    expect(result.message).toContain('ssh=255')
    expect(result.message).toContain('Could not resolve')
  })

  test('throws SshSourceFailure when upstream emits invalid gzip (tar fails)', async () => {
    const result = await runSshTarPipeline({
      upstream: ['sh', '-c', 'printf "not a tar archive"'],
      dataDir,
      host: 'fake',
      since: SINCE,
      until: UNTIL,
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('host=fake')
    expect(result.message).not.toContain('tar=0')
  })

  test('captures both stderr streams when both sides fail', async () => {
    const result = await runSshTarPipeline({
      upstream: [
        'sh',
        '-c',
        'echo "upstream sad" >&2; printf "garbage" ; exit 7',
      ],
      dataDir,
      host: 'fake',
      since: SINCE,
      until: UNTIL,
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('ssh=7')
    expect(result.message).toContain('upstream sad')
  })
})

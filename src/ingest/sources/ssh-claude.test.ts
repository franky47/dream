import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
let outDir: string
let fixtureDir: string

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-ssh-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  outDir = path.join(workDir, 'out')
  fixtureDir = path.join(workDir, 'fixture')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(fixtureDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeFixture(relPath: string, content: string): void {
  const full = path.join(fixtureDir, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
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
  test('extracts a tar stream from upstream and reports metrics', async () => {
    writeFixture('-Users-franky-projA/aaa.jsonl', '{"type":"user"}\n')
    writeFixture('-Users-franky-projB/bbb.jsonl', '{"type":"user"}\n')

    const result = await runSshTarPipeline({
      upstream: ['sh', '-c', `tar -czf - -C ${fixtureDir} .`],
      outDir,
      host: 'fake',
    })

    expect(listFiles(outDir).filter((f) => !f.startsWith('.'))).toEqual([
      '-Users-franky-projA/aaa.jsonl',
      '-Users-franky-projB/bbb.jsonl',
    ])
    expect(result).toEqual({
      sessions_pulled: 2,
      memories_pulled: 0,
      bytes: 32,
    })
    expect(
      readFileSync(path.join(outDir, '-Users-franky-projA/aaa.jsonl'), 'utf-8'),
    ).toBe('{"type":"user"}\n')
  })

  test('splits sessions vs memories in metrics when extracting a mixed payload', async () => {
    writeFixture('-Users-franky-projA/aaa.jsonl', '{"type":"user"}\n')
    writeFixture('-Users-franky-projA/memory/feedback_x.md', 'memo body\n')
    writeFixture('-Users-franky-projA/memory/MEMORY.md', '- index\n')

    const result = await runSshTarPipeline({
      upstream: ['sh', '-c', `tar -czf - -C ${fixtureDir} .`],
      outDir,
      host: 'fake',
    })

    expect(listFiles(outDir).filter((f) => !f.startsWith('.'))).toEqual([
      '-Users-franky-projA/aaa.jsonl',
      '-Users-franky-projA/memory/MEMORY.md',
      '-Users-franky-projA/memory/feedback_x.md',
    ])
    expect(result.sessions_pulled).toBe(1)
    expect(result.memories_pulled).toBe(2)
  })

  test('handles an empty tar (no files matched on remote) as success', async () => {
    const result = await runSshTarPipeline({
      upstream: ['sh', '-c', `tar -czf - -T /dev/null`],
      outDir,
      host: 'fake',
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
      outDir,
      host: 'invalid.example',
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
      outDir,
      host: 'fake',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('host=fake')
    // tar exit code is non-zero; the exact code varies by tar implementation
    expect(result.message).not.toContain('tar=0')
  })

  test('captures both stderr streams when both sides fail', async () => {
    const result = await runSshTarPipeline({
      upstream: [
        'sh',
        '-c',
        'echo "upstream sad" >&2; printf "garbage" ; exit 7',
      ],
      outDir,
      host: 'fake',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('ssh=7')
    expect(result.message).toContain('upstream sad')
  })
})

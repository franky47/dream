import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ingestLocalClaude } from '#src/ingest/sources/local-claude'

let workDir: string
let sourceDir: string
let outDir: string

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-m4x-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  sourceDir = path.join(workDir, 'projects')
  outDir = path.join(workDir, 'out')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeJsonl(relPath: string, content: string, mtime: Date): void {
  const full = path.join(sourceDir, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
  utimesSync(full, mtime, mtime)
}

function writeMemory(relPath: string, content: string, mtime: Date): void {
  const full = path.join(sourceDir, relPath)
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

const IN_WINDOW = new Date('2026-05-09T12:00:00.000Z')
const OUT_OF_WINDOW = new Date('2026-05-01T12:00:00.000Z')
const SINCE = new Date('2026-05-08T00:00:00.000Z')

describe('ingestLocalClaude', () => {
  test('exposes machine + source labels from input', () => {
    const src = ingestLocalClaude({ machine: 'm4x', sourceDir })
    expect(src.machine).toBe('m4x')
    expect(src.source).toBe('claude')
  })

  test('uses the supplied machine label', () => {
    const src = ingestLocalClaude({ machine: 'echo', sourceDir })
    expect(src.machine).toBe('echo')
  })

  test('copies only in-window jsonl files, preserving relative paths', async () => {
    writeJsonl(
      '-Users-franky-projA/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )
    writeJsonl(
      '-Users-franky-projB/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl',
      '{"type":"user"}\n',
      OUT_OF_WINDOW,
    )

    const src = ingestLocalClaude({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(listFiles(outDir)).toEqual([
      '-Users-franky-projA/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
      '-Users-franky-projA/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md',
    ])
    expect(metrics).toEqual({
      sessions_pulled: 1,
      memories_pulled: 0,
      bytes: 16,
    })
  })

  test('excludes paths under **/subagents/**', async () => {
    writeJsonl(
      '-Users-franky-projA/subagents/cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )
    writeJsonl(
      '-Users-franky-projA/dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )

    const src = ingestLocalClaude({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(listFiles(outDir)).toEqual([
      '-Users-franky-projA/dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl',
      '-Users-franky-projA/dddddddd-dddd-dddd-dddd-dddddddddddd.md',
    ])
    expect(metrics.sessions_pulled).toBe(1)
  })

  test('copies in-window memory/*.md files alongside sessions, including MEMORY.md', async () => {
    writeJsonl(
      '-Users-franky-projA/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
      '{"type":"user"}\n',
      IN_WINDOW,
    )
    writeMemory(
      '-Users-franky-projA/memory/feedback_foo.md',
      '---\nname: foo\n---\nbody\n',
      IN_WINDOW,
    )
    writeMemory(
      '-Users-franky-projA/memory/MEMORY.md',
      '- [foo](feedback_foo.md)\n',
      IN_WINDOW,
    )
    writeMemory(
      '-Users-franky-projA/memory/feedback_old.md',
      'stale\n',
      OUT_OF_WINDOW,
    )

    const src = ingestLocalClaude({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(listFiles(outDir)).toEqual([
      '-Users-franky-projA/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
      '-Users-franky-projA/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md',
      '-Users-franky-projA/memory/MEMORY.md',
      '-Users-franky-projA/memory/feedback_foo.md',
    ])
    expect(metrics.sessions_pulled).toBe(1)
    expect(metrics.memories_pulled).toBe(2)
  })

  test('skips nested .md files under memory/ subdirectories (flat scope)', async () => {
    writeMemory(
      '-Users-franky-projA/memory/feedback_foo.md',
      'top\n',
      IN_WINDOW,
    )
    writeMemory(
      '-Users-franky-projA/memory/sub/nested.md',
      'nested\n',
      IN_WINDOW,
    )

    const src = ingestLocalClaude({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(listFiles(outDir)).toEqual([
      '-Users-franky-projA/memory/feedback_foo.md',
    ])
    expect(metrics.memories_pulled).toBe(1)
  })

  test('writes a sibling .md for each pulled .jsonl with valid YAML frontmatter', async () => {
    writeJsonl(
      '-Users-franky-projA/ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl',
      JSON.stringify({
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/repo',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'hello world' },
      }) + '\n',
      IN_WINDOW,
    )

    const src = ingestLocalClaude({ machine: 'm4x', sourceDir })
    await src.pull({ outDir, since: SINCE })

    const md = readFileSync(
      path.join(
        outDir,
        '-Users-franky-projA/ffffffff-ffff-ffff-ffff-ffffffffffff.md',
      ),
      'utf-8',
    )
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('sessionId: ses_1')
    expect(md).toContain('renderer: "claude-md@1"')
    expect(md).toContain('<turn n="1" role="user" t="0"/>')
    expect(md).toContain('hello world')
  })

  test('copied bytes match the source files', async () => {
    const content = '{"type":"user","message":{"content":"hi"}}\n'
    writeJsonl(
      '-Users-franky-projA/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl',
      content,
      IN_WINDOW,
    )
    const src = ingestLocalClaude({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(metrics.bytes).toBe(Buffer.byteLength(content))
    const copied = readFileSync(
      path.join(
        outDir,
        '-Users-franky-projA/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl',
      ),
      'utf-8',
    )
    expect(copied).toBe(content)
    expect(
      statSync(
        path.join(
          outDir,
          '-Users-franky-projA/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl',
        ),
      ).size,
    ).toBe(Buffer.byteLength(content))
  })
})

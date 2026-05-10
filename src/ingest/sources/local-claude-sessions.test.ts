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

import { ingestLocalClaudeSessions } from '#src/ingest/sources/local-claude-sessions'

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

describe('ingestLocalClaudeSessions', () => {
  test('exposes machine + source labels from input', () => {
    const src = ingestLocalClaudeSessions({ machine: 'm4x', sourceDir })
    expect(src.machine).toBe('m4x')
    expect(src.source).toBe('claude-sessions')
  })

  test('uses the supplied machine label', () => {
    const src = ingestLocalClaudeSessions({ machine: 'echo', sourceDir })
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

    const src = ingestLocalClaudeSessions({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(listFiles(outDir)).toEqual([
      '-Users-franky-projA/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
    ])
    expect(metrics).toEqual({ files_pulled: 1, bytes: 16 })
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

    const src = ingestLocalClaudeSessions({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(listFiles(outDir)).toEqual([
      '-Users-franky-projA/dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl',
    ])
    expect(metrics.files_pulled).toBe(1)
  })

  test('copied bytes match the source files', async () => {
    const content = '{"type":"user","message":{"content":"hi"}}\n'
    writeJsonl(
      '-Users-franky-projA/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl',
      content,
      IN_WINDOW,
    )
    const src = ingestLocalClaudeSessions({ machine: 'm4x', sourceDir })
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

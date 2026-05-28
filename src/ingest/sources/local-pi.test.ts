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

import { ingestLocalPi } from '#src/ingest/sources/local-pi'

let workDir: string
let sourceDir: string
let dataDir: string

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-pi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  sourceDir = path.join(workDir, 'pi-agent')
  dataDir = path.join(workDir, 'data')
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeAt(relPath: string, content: string, mtime: Date): void {
  const full = path.join(sourceDir, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
  utimesSync(full, mtime, mtime)
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
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
const AFTER_WINDOW = new Date('2026-05-11T12:00:00.000Z')
const SINCE = new Date('2026-05-08T00:00:00.000Z')
const UNTIL = new Date('2026-05-10T00:00:00.000Z')
const BUCKET = '2026-05-09/m4x/pi'

const HEADER = JSON.stringify({
  type: 'session',
  version: 3,
  id: 'ses_1',
  timestamp: '2026-05-09T11:00:00.000Z',
  cwd: '/repo',
})

describe('ingestLocalPi', () => {
  test('exposes machine + source labels', () => {
    mkdirSync(sourceDir, { recursive: true })
    const src = ingestLocalPi({ machine: 'm4x', sourceDir })
    expect(src.machine).toBe('m4x')
    expect(src.source).toBe('pi')
  })

  test('copies in-window jsonl into day-bucket preserving the project slug subdir', async () => {
    writeAt(
      'sessions/--Users-franky-projA--/rollout-aaa.jsonl',
      `${HEADER}\n`,
      IN_WINDOW,
    )
    writeAt(
      'sessions/--Users-franky-projB--/rollout-old.jsonl',
      `${HEADER}\n`,
      OUT_OF_WINDOW,
    )

    const src = ingestLocalPi({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(listFiles(dataDir)).toEqual([
      `${BUCKET}/--Users-franky-projA--/rollout-aaa.jsonl`,
      `${BUCKET}/--Users-franky-projA--/rollout-aaa.md`,
    ])
    expect(metrics).toEqual({
      sessions_pulled: 1,
      bytes: Buffer.byteLength(`${HEADER}\n`),
    })
  })

  test('excludes files modified at or after until', async () => {
    writeAt(
      'sessions/--Users-franky-projA--/in.jsonl',
      `${HEADER}\n`,
      IN_WINDOW,
    )
    writeAt(
      'sessions/--Users-franky-projA--/after.jsonl',
      `${HEADER}\n`,
      AFTER_WINDOW,
    )

    const src = ingestLocalPi({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(listFiles(dataDir)).toEqual([
      `${BUCKET}/--Users-franky-projA--/in.jsonl`,
      `${BUCKET}/--Users-franky-projA--/in.md`,
    ])
    expect(metrics.sessions_pulled).toBe(1)
  })

  test('routes sessions to the day-bucket of their own mtime', async () => {
    writeAt(
      'sessions/--Users-franky-projA--/a.jsonl',
      `${HEADER}\n`,
      new Date('2026-05-08T09:00:00.000Z'),
    )
    writeAt(
      'sessions/--Users-franky-projA--/b.jsonl',
      `${HEADER}\n`,
      new Date('2026-05-09T22:00:00.000Z'),
    )

    const src = ingestLocalPi({ machine: 'm4x', sourceDir })
    await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(listFiles(dataDir)).toEqual([
      '2026-05-08/m4x/pi/--Users-franky-projA--/a.jsonl',
      '2026-05-08/m4x/pi/--Users-franky-projA--/a.md',
      '2026-05-09/m4x/pi/--Users-franky-projA--/b.jsonl',
      '2026-05-09/m4x/pi/--Users-franky-projA--/b.md',
    ])
  })

  test('writes a sibling .md for each pulled .jsonl with valid YAML frontmatter', async () => {
    writeAt(
      'sessions/--Users-franky-projA--/rollout-x.jsonl',
      `${HEADER}\n`,
      IN_WINDOW,
    )

    const src = ingestLocalPi({ machine: 'm4x', sourceDir })
    await src.pull({ dataDir, since: SINCE, until: UNTIL })

    const md = readFileSync(
      path.join(dataDir, `${BUCKET}/--Users-franky-projA--/rollout-x.md`),
      'utf-8',
    )
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('sessionId: ses_1')
    expect(md).toContain('renderer: "pi-md@1"')
  })

  test('missing sourceDir → zero metrics, no failure', async () => {
    const src = ingestLocalPi({
      machine: 'm4x',
      sourceDir: path.join(workDir, 'nope'),
    })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })
    expect(metrics).toEqual({ sessions_pulled: 0, bytes: 0 })
    expect(listFiles(dataDir)).toEqual([])
  })

  test('missing sessions/ subdir → zero metrics, no failure', async () => {
    mkdirSync(sourceDir, { recursive: true })
    const src = ingestLocalPi({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })
    expect(metrics).toEqual({ sessions_pulled: 0, bytes: 0 })
  })
})

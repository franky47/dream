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

import { ingestLocalCodex } from '#src/ingest/sources/local-codex'

let workDir: string
let sourceDir: string
let dataDir: string

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  sourceDir = path.join(workDir, 'codex')
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
const BUCKET = '2026-05-09/m4x/codex'

const META = JSON.stringify({
  timestamp: '2026-05-09T11:00:00.000Z',
  type: 'session_meta',
  payload: {
    id: 'ses_1',
    timestamp: '2026-05-09T11:00:00.000Z',
    cwd: '/repo',
    originator: 'Codex CLI',
    cli_version: '0.1.0',
    model_provider: 'openai',
    git: null,
  },
})

describe('ingestLocalCodex', () => {
  test('exposes machine + source labels', () => {
    mkdirSync(sourceDir, { recursive: true })
    const src = ingestLocalCodex({ machine: 'm4x', sourceDir })
    expect(src.machine).toBe('m4x')
    expect(src.source).toBe('codex')
  })

  test('copies in-window session jsonl into flat day-bucket, drops source date tree', async () => {
    writeAt('sessions/2026/05/09/rollout-aaa.jsonl', `${META}\n`, IN_WINDOW)
    writeAt('sessions/2026/05/01/rollout-old.jsonl', `${META}\n`, OUT_OF_WINDOW)

    const src = ingestLocalCodex({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(listFiles(dataDir)).toEqual([
      `${BUCKET}/rollout-aaa.jsonl`,
      `${BUCKET}/rollout-aaa.md`,
    ])
    expect(metrics).toEqual({
      sessions_pulled: 1,
      memories_pulled: 0,
      bytes: Buffer.byteLength(`${META}\n`),
    })
  })

  test('excludes files modified at or after until', async () => {
    writeAt('sessions/2026/05/09/in.jsonl', `${META}\n`, IN_WINDOW)
    writeAt('sessions/2026/05/11/after.jsonl', `${META}\n`, AFTER_WINDOW)

    const src = ingestLocalCodex({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(listFiles(dataDir)).toEqual([
      `${BUCKET}/in.jsonl`,
      `${BUCKET}/in.md`,
    ])
    expect(metrics.sessions_pulled).toBe(1)
  })

  test('routes sessions to day-bucket of their own mtime', async () => {
    writeAt(
      'sessions/2026/05/09/a.jsonl',
      `${META}\n`,
      new Date('2026-05-08T09:00:00.000Z'),
    )
    writeAt(
      'sessions/2026/05/09/b.jsonl',
      `${META}\n`,
      new Date('2026-05-09T22:00:00.000Z'),
    )

    const src = ingestLocalCodex({ machine: 'm4x', sourceDir })
    await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(listFiles(dataDir)).toEqual([
      '2026-05-08/m4x/codex/a.jsonl',
      '2026-05-08/m4x/codex/a.md',
      '2026-05-09/m4x/codex/b.jsonl',
      '2026-05-09/m4x/codex/b.md',
    ])
  })

  test('writes a sibling .md for each pulled .jsonl with valid YAML frontmatter', async () => {
    writeAt('sessions/2026/05/09/rollout-x.jsonl', `${META}\n`, IN_WINDOW)

    const src = ingestLocalCodex({ machine: 'm4x', sourceDir })
    await src.pull({ dataDir, since: SINCE, until: UNTIL })

    const md = readFileSync(
      path.join(dataDir, `${BUCKET}/rollout-x.md`),
      'utf-8',
    )
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('sessionId: ses_1')
    expect(md).toContain('renderer: "codex-md@1"')
  })

  test('copies memories preserving subtree, bucketed by file mtime', async () => {
    writeAt('sessions/2026/05/09/rollout-x.jsonl', `${META}\n`, IN_WINDOW)
    writeAt('memories/MEMORY.md', '- index\n', IN_WINDOW)
    writeAt('memories/rollout_summaries/foo.md', '# foo\n', IN_WINDOW)
    writeAt('memories/skills/handoff/SKILL.md', '# skill\n', IN_WINDOW)
    writeAt('memories/stale.md', 'old\n', OUT_OF_WINDOW)

    const src = ingestLocalCodex({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(listFiles(dataDir)).toEqual([
      `${BUCKET}/memories/MEMORY.md`,
      `${BUCKET}/memories/rollout_summaries/foo.md`,
      `${BUCKET}/memories/skills/handoff/SKILL.md`,
      `${BUCKET}/rollout-x.jsonl`,
      `${BUCKET}/rollout-x.md`,
    ])
    expect(metrics.sessions_pulled).toBe(1)
    expect(metrics.memories_pulled).toBe(3)
  })

  test('missing sourceDir → zero metrics, no failure', async () => {
    const src = ingestLocalCodex({
      machine: 'm4x',
      sourceDir: path.join(workDir, 'nope'),
    })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })
    expect(metrics).toEqual({
      sessions_pulled: 0,
      memories_pulled: 0,
      bytes: 0,
    })
    expect(listFiles(dataDir)).toEqual([])
  })

  test('missing sessions/ subtree but present memories/ still pulls memories', async () => {
    writeAt('memories/MEMORY.md', '- index\n', IN_WINDOW)

    const src = ingestLocalCodex({ machine: 'm4x', sourceDir })
    const metrics = await src.pull({ dataDir, since: SINCE, until: UNTIL })

    expect(metrics.sessions_pulled).toBe(0)
    expect(metrics.memories_pulled).toBe(1)
    expect(listFiles(dataDir)).toEqual([`${BUCKET}/memories/MEMORY.md`])
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { IngestFatal, run, type Source } from '#src/ingest/orchestrator'

let dataDir: string

beforeEach(() => {
  dataDir = path.join(
    tmpdir(),
    `dream-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const SINCE = new Date('2026-05-08T00:00:00.000Z')
const UNTIL = new Date('2026-05-10T00:00:00.000Z')

function seedFile(rel: string, contents: string): string {
  const full = path.join(dataDir, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, contents)
  return full
}

describe('orchestrator.run', () => {
  test('clears the day-buckets inside the window before pulling', async () => {
    seedFile('2026-05-08/m4x/claude/stale.txt', 'old')
    seedFile('2026-05-09/m4x/claude/stale.txt', 'old')

    let observed: string[] = []
    const source: Source = {
      machine: 'm4x',
      source: 'fake',
      pull: async ({ dataDir: dir }) => {
        observed = [
          existsSync(path.join(dir, '2026-05-08/m4x/claude/stale.txt')),
          existsSync(path.join(dir, '2026-05-09/m4x/claude/stale.txt')),
        ].map(String)
        return {}
      },
    }

    await run({
      sources: [source],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'all',
    })
    expect(observed).toEqual(['false', 'false'])
  })

  test("with clearScope 'source', clears only the selected sources' subtrees", async () => {
    const stale = seedFile('2026-05-08/m4x/fake/stale.txt', 'old')
    const sibling = seedFile('2026-05-08/m4x/claude/keep.txt', 'keep')
    const otherMachine = seedFile('2026-05-08/hex/fake/keep.txt', 'keep')

    const source: Source = {
      machine: 'm4x',
      source: 'fake',
      pull: async () => ({}),
    }
    await run({
      sources: [source],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'filtered',
    })

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(otherMachine)).toBe(true)
  })

  test("with clearScope 'source', clears duplicate machine/source pairs once", async () => {
    seedFile('2026-05-08/m4x/fake/stale.txt', 'old')

    const cleared: string[] = []
    const make = (): Source => ({
      machine: 'm4x',
      source: 'fake',
      pull: async () => ({}),
    })
    const outcome = await run({
      sources: [make(), make()],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'filtered',
      clearDir: async (dir) => {
        cleared.push(dir)
      },
    })
    if (outcome instanceof Error) throw new Error('unexpected fatal')

    expect(cleared).toEqual([
      path.join(dataDir, '2026-05-08', 'm4x', 'fake'),
      path.join(dataDir, '2026-05-09', 'm4x', 'fake'),
    ])
  })

  test('leaves day-buckets outside the window untouched', async () => {
    const keep = seedFile('2026-05-01/m4x/claude/keep.txt', 'keep')
    const meta = seedFile('_meta/2026-05-09.json', '{}')

    const source: Source = {
      machine: 'm4x',
      source: 'fake',
      pull: async () => ({}),
    }
    await run({
      sources: [source],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'all',
    })

    expect(existsSync(keep)).toBe(true)
    expect(existsSync(meta)).toBe(true)
  })

  test('passes dataDir, since and until through to each source', async () => {
    const received: Array<{ dataDir: string; since: Date; until: Date }> = []
    const source: Source = {
      machine: 'm4x',
      source: 'fake',
      pull: async (opts) => {
        received.push(opts)
        return {}
      },
    }

    await run({
      sources: [source],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'all',
    })
    expect(received).toEqual([{ dataDir, since: SINCE, until: UNTIL }])
  })

  test('aborts fatally when a day-bucket clear fails', async () => {
    const source: Source = {
      machine: 'm4x',
      source: 'fake',
      pull: async () => ({}),
    }
    const outcome = await run({
      sources: [source],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'all',
      clearDir: async (dir) =>
        new IngestFatal({ reason: `cannot clear ${dir}` }),
    })
    expect(IngestFatal.is(outcome)).toBe(true)
  })

  test('one source throwing does not abort the others', async () => {
    const flaky: Source = {
      machine: 'm4x',
      source: 'flaky',
      pull: async () => {
        throw new Error('boom')
      },
    }
    const happy: Source = {
      machine: 'm4x',
      source: 'happy',
      pull: async () => ({ files_pulled: 1, bytes: 10 }),
    }

    const outcome = await run({
      sources: [flaky, happy],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'all',
    })
    if (outcome instanceof Error) throw new Error('unexpected fatal')

    expect(outcome.results).toHaveLength(2)
    expect(outcome.results.find((r) => r.source === 'flaky')?.status).toBe(
      'error',
    )
    expect(outcome.results.find((r) => r.source === 'happy')?.status).toBe('ok')
  })

  test('records duration_ms for both ok and error outcomes', async () => {
    const slow: Source = {
      machine: 'm4x',
      source: 'slow-ok',
      pull: async () => {
        await Bun.sleep(20)
        return { files_pulled: 0, bytes: 0 }
      },
    }
    const slowFail: Source = {
      machine: 'm4x',
      source: 'slow-err',
      pull: async () => {
        await Bun.sleep(20)
        throw new Error('late boom')
      },
    }

    const outcome = await run({
      sources: [slow, slowFail],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'all',
    })
    if (outcome instanceof Error) throw new Error('unexpected fatal')
    for (const r of outcome.results) {
      expect(r.durationMs).toBeGreaterThanOrEqual(15)
    }
  })

  test('runs sources concurrently (wall time ≈ max, not sum)', async () => {
    const SLEEP_MS = 80
    const make = (name: string): Source => ({
      machine: 'm4x',
      source: name,
      pull: async () => {
        await Bun.sleep(SLEEP_MS)
        return { files_pulled: 0, bytes: 0 }
      },
    })

    const start = performance.now()
    await run({
      sources: [make('a'), make('b')],
      dataDir,
      since: SINCE,
      until: UNTIL,
      sourceSelection: 'all',
    })
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(SLEEP_MS * 1.8)
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { run, type Source } from '#src/ingest/orchestrator'

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

describe('orchestrator.run', () => {
  test('wipes outDir before invoking pull', async () => {
    const outDir = path.join(dataDir, 'm4x', 'fake')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'stale.txt'), 'leftover')

    let observedExists = true
    const source: Source = {
      machine: 'm4x',
      source: 'fake',
      pull: async ({ outDir }) => {
        observedExists = existsSync(path.join(outDir, 'stale.txt'))
        return { files_pulled: 0, bytes: 0 }
      },
    }

    await run({ sources: [source], dataDir, since: SINCE })
    expect(observedExists).toBe(false)
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
    })

    expect(outcome.results).toHaveLength(2)
    const flakyResult = outcome.results.find((r) => r.source === 'flaky')
    const happyResult = outcome.results.find((r) => r.source === 'happy')
    expect(flakyResult?.status).toBe('error')
    expect(happyResult?.status).toBe('ok')
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
    })
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
    })
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(SLEEP_MS * 1.8)
  })
})

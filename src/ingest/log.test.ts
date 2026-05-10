import { describe, expect, test } from 'bun:test'

import { buildRunLog } from '#src/ingest/log'

const RUN_START = new Date('2026-05-10T00:00:00.000Z')
const RUN_END = new Date('2026-05-10T00:01:23.000Z')

describe('buildRunLog', () => {
  test('produces a payload with no sources when given empty results', () => {
    const payload = buildRunLog({
      runStartedAt: RUN_START,
      runFinishedAt: RUN_END,
      results: [],
    })
    expect(payload).toEqual({
      run_started_at: '2026-05-10T00:00:00.000Z',
      run_finished_at: '2026-05-10T00:01:23.000Z',
      sources: [],
    })
  })

  test('flattens ok metrics into source entries', () => {
    const payload = buildRunLog({
      runStartedAt: RUN_START,
      runFinishedAt: RUN_END,
      results: [
        {
          machine: 'm4x',
          source: 'claude-sessions',
          status: 'ok',
          durationMs: 1200,
          metrics: { files_pulled: 7, bytes: 45_678 },
        },
      ],
    })
    expect(payload.sources).toEqual([
      {
        machine: 'm4x',
        source: 'claude-sessions',
        status: 'ok',
        duration_ms: 1200,
        files_pulled: 7,
        bytes: 45_678,
      },
    ])
  })

  test('preserves error entries verbatim', () => {
    const payload = buildRunLog({
      runStartedAt: RUN_START,
      runFinishedAt: RUN_END,
      results: [
        {
          machine: 'echo',
          source: 'claude-sessions',
          status: 'error',
          durationMs: 42,
          error: {
            name: 'SourceFailure',
            message: 'ssh refused',
            tag: 'SourceFailure',
          },
        },
      ],
    })
    expect(payload.sources[0]).toEqual({
      machine: 'echo',
      source: 'claude-sessions',
      status: 'error',
      duration_ms: 42,
      error: {
        name: 'SourceFailure',
        message: 'ssh refused',
        tag: 'SourceFailure',
      },
    })
  })

  test('handles a mixed run with both ok and error entries', () => {
    const payload = buildRunLog({
      runStartedAt: RUN_START,
      runFinishedAt: RUN_END,
      results: [
        {
          machine: 'm4x',
          source: 'claude-sessions',
          status: 'ok',
          durationMs: 100,
          metrics: { files_pulled: 1, bytes: 10 },
        },
        {
          machine: 'm4x',
          source: 'firefox',
          status: 'error',
          durationMs: 5,
          error: { name: 'Error', message: 'sqlite locked', tag: null },
        },
      ],
    })
    expect(payload.sources).toHaveLength(2)
    expect(payload.sources[0]?.status).toBe('ok')
    expect(payload.sources[1]?.status).toBe('error')
  })

  test('handles a run where every source failed', () => {
    const payload = buildRunLog({
      runStartedAt: RUN_START,
      runFinishedAt: RUN_END,
      results: [
        {
          machine: 'm4x',
          source: 'claude-sessions',
          status: 'error',
          durationMs: 1,
          error: { name: 'Error', message: 'glob failed', tag: null },
        },
        {
          machine: 'echo',
          source: 'claude-sessions',
          status: 'error',
          durationMs: 2,
          error: {
            name: 'SourceFailure',
            message: 'ssh refused',
            tag: 'SourceFailure',
          },
        },
      ],
    })
    expect(payload.sources).toHaveLength(2)
    expect(payload.sources.every((s) => s.status === 'error')).toBe(true)
  })

  test('emits ISO 8601 UTC timestamps', () => {
    const payload = buildRunLog({
      runStartedAt: new Date('2026-01-02T03:04:05.678Z'),
      runFinishedAt: new Date('2026-01-02T03:04:06.000Z'),
      results: [],
    })
    expect(payload.run_started_at).toBe('2026-01-02T03:04:05.678Z')
    expect(payload.run_finished_at).toBe('2026-01-02T03:04:06.000Z')
  })
})

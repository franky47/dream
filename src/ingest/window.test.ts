import { describe, expect, test } from 'bun:test'

import { WindowError, resolveWindow } from '#src/ingest/window'

const NOW = new Date('2026-05-14T12:00:00.000Z')

function unwrap(result: ReturnType<typeof resolveWindow>) {
  if (result instanceof Error)
    throw new Error(`unexpected error: ${result.message}`)
  return result
}

describe('resolveWindow', () => {
  test('with no flags, resolves to the last 48 hours up to now', () => {
    const window = unwrap(
      resolveWindow({ since: undefined, until: undefined }, NOW),
    )
    expect(window.since.toISOString()).toBe('2026-05-12T12:00:00.000Z')
    expect(window.until.toISOString()).toBe('2026-05-14T12:00:00.000Z')
    expect(window.untilWasExplicit).toBe(false)
  })

  test('with --since only, resolves to [since, now)', () => {
    const window = unwrap(
      resolveWindow({ since: '2026-05-01', until: undefined }, NOW),
    )
    expect(window.since.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(window.until.toISOString()).toBe('2026-05-14T12:00:00.000Z')
    expect(window.untilWasExplicit).toBe(false)
  })

  test('with both flags, resolves to [since, until) and flags untilWasExplicit', () => {
    const window = unwrap(
      resolveWindow({ since: '2026-02-01', until: '2026-03-01' }, NOW),
    )
    expect(window.since.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    expect(window.until.toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(window.untilWasExplicit).toBe(true)
  })

  test('interprets a bare date as UTC midnight', () => {
    const window = unwrap(
      resolveWindow({ since: '2026-01-15', until: undefined }, NOW),
    )
    expect(window.since.toISOString()).toBe('2026-01-15T00:00:00.000Z')
  })

  test('honours a full ISO datetime as-is', () => {
    const window = unwrap(
      resolveWindow(
        { since: '2026-01-15T08:30:00.000Z', until: undefined },
        NOW,
      ),
    )
    expect(window.since.toISOString()).toBe('2026-01-15T08:30:00.000Z')
  })

  test('rejects --until without --since', () => {
    const result = resolveWindow({ since: undefined, until: '2026-03-01' }, NOW)
    expect(WindowError.is(result)).toBe(true)
  })

  test('rejects a window where since >= until', () => {
    const result = resolveWindow(
      { since: '2026-03-01', until: '2026-03-01' },
      NOW,
    )
    expect(WindowError.is(result)).toBe(true)
  })

  test('rejects an unparseable --since value', () => {
    const result = resolveWindow({ since: 'not-a-date', until: undefined }, NOW)
    expect(WindowError.is(result)).toBe(true)
  })

  test('rejects an unparseable --until value', () => {
    const result = resolveWindow(
      { since: '2026-01-01', until: '15/03/2026' },
      NOW,
    )
    expect(WindowError.is(result)).toBe(true)
  })
})

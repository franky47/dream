import { describe, expect, test } from 'bun:test'

import { daysInRange, utcDay } from '#lib/utc-day'

describe('utcDay', () => {
  test('returns the UTC YYYY-MM-DD for a datetime', () => {
    expect(utcDay(new Date('2026-01-15T12:34:56.000Z'))).toBe('2026-01-15')
  })

  test('buckets by the UTC day, not the local day', () => {
    expect(utcDay(new Date('2026-01-15T23:59:59.999Z'))).toBe('2026-01-15')
    expect(utcDay(new Date('2026-01-16T00:00:00.000Z'))).toBe('2026-01-16')
  })
})

describe('daysInRange', () => {
  test('enumerates every UTC day a window touches', () => {
    expect(
      daysInRange(
        new Date('2026-01-15T06:00:00.000Z'),
        new Date('2026-01-18T06:00:00.000Z'),
      ),
    ).toEqual(['2026-01-15', '2026-01-16', '2026-01-17', '2026-01-18'])
  })

  test('treats the upper bound as exclusive (floor of until - 1ms)', () => {
    expect(
      daysInRange(
        new Date('2026-01-15T00:00:00.000Z'),
        new Date('2026-01-16T00:00:00.000Z'),
      ),
    ).toEqual(['2026-01-15'])
  })

  test('returns a single day for a sub-day window', () => {
    expect(
      daysInRange(
        new Date('2026-01-15T08:00:00.000Z'),
        new Date('2026-01-15T17:00:00.000Z'),
      ),
    ).toEqual(['2026-01-15'])
  })

  test('returns an empty array for an empty range', () => {
    const instant = new Date('2026-01-15T08:00:00.000Z')
    expect(daysInRange(instant, instant)).toEqual([])
  })

  test('returns an empty array when since is after until', () => {
    expect(
      daysInRange(
        new Date('2026-01-16T00:00:00.000Z'),
        new Date('2026-01-15T00:00:00.000Z'),
      ),
    ).toEqual([])
  })

  test('crosses month and year boundaries', () => {
    expect(
      daysInRange(
        new Date('2026-12-31T12:00:00.000Z'),
        new Date('2027-01-02T12:00:00.000Z'),
      ),
    ).toEqual(['2026-12-31', '2027-01-01', '2027-01-02'])
  })
})

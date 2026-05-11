import { describe, expect, test } from 'bun:test'

import {
  applyPostPasses,
  collapseBlankRuns,
  stripAnsi,
  trimTrailingWhitespace,
} from './post-pass.ts'

describe('stripAnsi', () => {
  test('removes colour SGR sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  test('removes cursor-position sequences', () => {
    expect(stripAnsi('a\x1b[2;5Hb')).toBe('ab')
  })

  test('removes clear-line sequence', () => {
    expect(stripAnsi('abc\x1b[2Kdef')).toBe('abcdef')
  })

  test('no-op on text without escapes', () => {
    expect(stripAnsi('plain text\nline2')).toBe('plain text\nline2')
  })
})

describe('trimTrailingWhitespace', () => {
  test('trims trailing spaces and tabs per line', () => {
    expect(trimTrailingWhitespace('foo   \nbar\t\nbaz')).toBe('foo\nbar\nbaz')
  })

  test('preserves leading whitespace', () => {
    expect(trimTrailingWhitespace('  indented   \n  more')).toBe(
      '  indented\n  more',
    )
  })

  test('preserves empty lines', () => {
    expect(trimTrailingWhitespace('a\n\nb')).toBe('a\n\nb')
  })
})

describe('collapseBlankRuns', () => {
  test('collapses 3+ consecutive blanks to 1', () => {
    expect(collapseBlankRuns('a\n\n\n\nb')).toBe('a\n\nb')
  })

  test('preserves 2 consecutive blanks', () => {
    expect(collapseBlankRuns('a\n\nb')).toBe('a\n\nb')
  })

  test('treats whitespace-only lines as blank', () => {
    expect(collapseBlankRuns('a\n\n  \n\t\nb')).toBe('a\n\nb')
  })
})

describe('applyPostPasses', () => {
  test('runs ansi-strip + trim + collapse in order', () => {
    const input = '\x1b[31mfoo   \x1b[0m\n\n\n\n   \nbar  '
    const out = applyPostPasses(input)
    expect(out).toBe('foo\n\nbar')
  })

  test('no-op on clean body', () => {
    expect(applyPostPasses('foo\nbar')).toBe('foo\nbar')
  })
})

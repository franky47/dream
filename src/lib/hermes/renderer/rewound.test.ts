import { describe, expect, test } from 'bun:test'

import { isRewound } from './rewound.ts'

describe('isRewound', () => {
  test('flags a row whose active flag is zero', () => {
    expect(isRewound({ active: 0 })).toBe(true)
  })

  test('leaves an active row live', () => {
    expect(isRewound({ active: 1 })).toBe(false)
  })

  test('treats a row without an active flag as live', () => {
    expect(isRewound({ role: 'user', content: 'hi' })).toBe(false)
  })

  test('treats a null active flag as live', () => {
    expect(isRewound({ active: null })).toBe(false)
  })

  test('ignores a non-numeric active value rather than dropping the row', () => {
    expect(isRewound({ active: 'false' })).toBe(false)
  })

  test('ignores non-object rows', () => {
    expect(isRewound(null)).toBe(false)
    expect(isRewound('message')).toBe(false)
  })
})

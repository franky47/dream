import { describe, expect, test } from 'bun:test'

import { ConfigError, parseConfig } from '#src/config'

describe('parseConfig', () => {
  test('returns parsed config for valid env', () => {
    const result = parseConfig({ DREAM_DATA_DIR: '/tmp/dream-data' })
    if (result instanceof Error) throw result
    expect(result.dataDir).toBe('/tmp/dream-data')
  })

  test('returns ConfigError when DREAM_DATA_DIR is missing', () => {
    const result = parseConfig({})
    expect(result).toBeInstanceOf(ConfigError)
  })

  test('returns ConfigError when DREAM_DATA_DIR is empty', () => {
    const result = parseConfig({ DREAM_DATA_DIR: '' })
    expect(result).toBeInstanceOf(ConfigError)
  })
})

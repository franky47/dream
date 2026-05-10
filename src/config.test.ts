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

  test('defaults machine to "local" when DREAM_MACHINE is unset', () => {
    const result = parseConfig({ DREAM_DATA_DIR: '/tmp/dream-data' })
    if (result instanceof Error) throw result
    expect(result.machine).toBe('local')
  })

  test('reads machine label from DREAM_MACHINE', () => {
    const result = parseConfig({
      DREAM_DATA_DIR: '/tmp/dream-data',
      DREAM_MACHINE: 'm4x',
    })
    if (result instanceof Error) throw result
    expect(result.machine).toBe('m4x')
  })

  test('echoHost is null when DREAM_ECHO_HOST is unset', () => {
    const result = parseConfig({ DREAM_DATA_DIR: '/tmp/dream-data' })
    if (result instanceof Error) throw result
    expect(result.echoHost).toBeNull()
  })

  test('echoHost is read from DREAM_ECHO_HOST when set', () => {
    const result = parseConfig({
      DREAM_DATA_DIR: '/tmp/dream-data',
      DREAM_ECHO_HOST: 'echo.local',
    })
    if (result instanceof Error) throw result
    expect(result.echoHost).toBe('echo.local')
  })

  test('returns ConfigError when DREAM_ECHO_HOST is empty', () => {
    const result = parseConfig({
      DREAM_DATA_DIR: '/tmp/dream-data',
      DREAM_ECHO_HOST: '',
    })
    expect(result).toBeInstanceOf(ConfigError)
  })
})

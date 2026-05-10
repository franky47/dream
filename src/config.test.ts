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

  test('remoteClaudeSessionsHosts is empty when DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS is unset', () => {
    const result = parseConfig({ DREAM_DATA_DIR: '/tmp/dream-data' })
    if (result instanceof Error) throw result
    expect(result.remoteClaudeSessionsHosts).toEqual([])
  })

  test('parses comma-separated DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS', () => {
    const result = parseConfig({
      DREAM_DATA_DIR: '/tmp/dream-data',
      DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS: 'echo,alpha,beta',
    })
    if (result instanceof Error) throw result
    expect(result.remoteClaudeSessionsHosts).toEqual(['echo', 'alpha', 'beta'])
  })

  test('trims whitespace and ignores empty entries in DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS', () => {
    const result = parseConfig({
      DREAM_DATA_DIR: '/tmp/dream-data',
      DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS: ' echo , , alpha ,',
    })
    if (result instanceof Error) throw result
    expect(result.remoteClaudeSessionsHosts).toEqual(['echo', 'alpha'])
  })

  test('firefoxProfiles is empty when DREAM_FIREFOX_PROFILES is unset', () => {
    const result = parseConfig({ DREAM_DATA_DIR: '/tmp/dream-data' })
    if (result instanceof Error) throw result
    expect(result.firefoxProfiles).toEqual([])
  })

  test('parses comma-separated DREAM_FIREFOX_PROFILES', () => {
    const result = parseConfig({
      DREAM_DATA_DIR: '/tmp/dream-data',
      DREAM_FIREFOX_PROFILES: '/path/to/work,/path/to/personal',
    })
    if (result instanceof Error) throw result
    expect(result.firefoxProfiles).toEqual([
      '/path/to/work',
      '/path/to/personal',
    ])
  })

  test('trims whitespace and ignores empty entries in DREAM_FIREFOX_PROFILES', () => {
    const result = parseConfig({
      DREAM_DATA_DIR: '/tmp/dream-data',
      DREAM_FIREFOX_PROFILES: ' /a , , /b ,',
    })
    if (result instanceof Error) throw result
    expect(result.firefoxProfiles).toEqual(['/a', '/b'])
  })
})

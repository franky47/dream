import { describe, expect, test } from 'bun:test'

import {
  applySourceFilters,
  CliError,
  parseCliArgs,
  sourceNames,
  type SourceFilter,
  type Transport,
} from '#src/ingest/cli'
import { ingestLocalClaude } from '#src/ingest/sources/local-claude'
import { ingestLocalCodex } from '#src/ingest/sources/local-codex'
import { ingestLocalFirefox } from '#src/ingest/sources/local-firefox'
import { ingestLocalOpencode } from '#src/ingest/sources/local-opencode'
import { ingestLocalPi } from '#src/ingest/sources/local-pi'
import { ingestSshClaude } from '#src/ingest/sources/ssh-claude'
import { ingestSshHermes } from '#src/ingest/sources/ssh-hermes'
import { ingestSshOpencode } from '#src/ingest/sources/ssh-opencode'

function unwrap<T>(result: T | CliError): T {
  if (result instanceof Error)
    throw new Error(`unexpected error: ${result.message}`)
  return result
}

function expectError(result: unknown): CliError {
  if (!CliError.is(result)) throw new Error('expected a CliError')
  return result
}

describe('parseCliArgs', () => {
  test('with no flags, yields no filters and no window values', () => {
    const args = unwrap(parseCliArgs([]))
    expect(args.help).toBe(false)
    expect(args.since).toBeUndefined()
    expect(args.until).toBeUndefined()
    expect(args.sourceFilters).toEqual([])
  })

  test('passes --since and --until through untouched', () => {
    const args = unwrap(
      parseCliArgs(['--since', '2026-02-01', '--until', '2026-03-01']),
    )
    expect(args.since).toBe('2026-02-01')
    expect(args.until).toBe('2026-03-01')
  })

  test('parses a bare source name with no transport', () => {
    const args = unwrap(parseCliArgs(['--source', 'claude']))
    expect(args.sourceFilters).toEqual([
      { raw: 'claude', name: 'claude', transport: null },
    ])
  })

  test('parses a name:location term', () => {
    const args = unwrap(parseCliArgs(['--source', 'claude:local']))
    expect(args.sourceFilters).toEqual([
      { raw: 'claude:local', name: 'claude', transport: 'local' },
    ])
  })

  test('accepts the -s short alias', () => {
    const args = unwrap(parseCliArgs(['-s', 'pi']))
    expect(args.sourceFilters).toEqual([
      { raw: 'pi', name: 'pi', transport: null },
    ])
  })

  test('accumulates repeated --source flags in order', () => {
    const args = unwrap(parseCliArgs(['-s', 'claude', '-s', 'pi:remote']))
    expect(args.sourceFilters).toEqual([
      { raw: 'claude', name: 'claude', transport: null },
      { raw: 'pi:remote', name: 'pi', transport: 'remote' },
    ])
  })

  test('rejects an unknown source name, listing valid names', () => {
    const error = expectError(parseCliArgs(['--source', 'claud']))
    expect(error.message).toContain('unknown source "claud"')
    expect(error.message).toContain(sourceNames.join(', '))
  })

  test('rejects an unknown location token', () => {
    const error = expectError(parseCliArgs(['--source', 'claude:cloud']))
    expect(error.message).toContain('unknown location "cloud"')
  })

  test('rejects a term with more than one colon', () => {
    const error = expectError(parseCliArgs(['--source', 'claude:local:x']))
    expect(error.message).toContain('malformed source term')
  })

  test('rejects an empty location after a colon', () => {
    const error = expectError(parseCliArgs(['--source', 'claude:']))
    expect(error.message).toContain('unknown location ""')
  })

  test('rejects unknown flags', () => {
    expect(CliError.is(parseCliArgs(['--bogus', 'x']))).toBe(true)
  })

  test('parses --help and -h', () => {
    expect(unwrap(parseCliArgs(['--help'])).help).toBe(true)
    expect(unwrap(parseCliArgs(['-h'])).help).toBe(true)
  })

  test('--help wins over invalid source terms', () => {
    expect(unwrap(parseCliArgs(['--help', '-s', 'bogus'])).help).toBe(true)
  })
})

describe('sourceNames', () => {
  test('matches the source names the factories declare', () => {
    const factoryNames = new Set(
      [
        ingestLocalClaude({ machine: 'm', sourceDir: '/x' }),
        ingestLocalOpencode({ machine: 'm' }),
        ingestLocalCodex({ machine: 'm', sourceDir: '/x' }),
        ingestLocalPi({ machine: 'm', sourceDir: '/x' }),
        ingestLocalFirefox({ machine: 'm', profileDir: '/x' }),
        ingestSshClaude({ host: 'h' }),
        ingestSshOpencode({ host: 'h' }),
        ingestSshHermes({ host: 'h' }),
      ].map((s) => s.source),
    )
    expect([...factoryNames].sort()).toEqual([...sourceNames].sort())
  })
})

type FakeSource = { source: string; machine: string }

function entry(
  transport: Transport,
  name: string,
  machine: string,
): { transport: Transport; source: FakeSource } {
  return { transport, source: { source: name, machine } }
}

const FLEET = [
  entry('local', 'claude', 'mac'),
  entry('local', 'pi', 'mac'),
  entry('remote', 'claude', 'hex'),
  entry('remote', 'claude', 'm4x'),
  entry('remote', 'hermes', 'hex'),
]

function filter(
  name: SourceFilter['name'],
  transport: Transport | null = null,
): SourceFilter {
  return {
    raw: transport === null ? name : `${name}:${transport}`,
    name,
    transport,
  }
}

describe('applySourceFilters', () => {
  test('with no filters, returns every source in order', () => {
    const sources = unwrap(applySourceFilters({ filters: [], sources: FLEET }))
    expect(sources).toEqual(FLEET.map((e) => e.source))
  })

  test('a bare name matches both transports', () => {
    const sources = unwrap(
      applySourceFilters({ filters: [filter('claude')], sources: FLEET }),
    )
    expect(sources.map((s) => s.machine)).toEqual(['mac', 'hex', 'm4x'])
  })

  test('a name:transport term narrows to one transport', () => {
    const sources = unwrap(
      applySourceFilters({
        filters: [filter('claude', 'remote')],
        sources: FLEET,
      }),
    )
    expect(sources.map((s) => s.machine)).toEqual(['hex', 'm4x'])
  })

  test('multiple filters union their matches, preserving source order', () => {
    const sources = unwrap(
      applySourceFilters({
        filters: [filter('hermes'), filter('pi', 'local')],
        sources: FLEET,
      }),
    )
    expect(sources.map((s) => s.source)).toEqual(['pi', 'hermes'])
  })

  test('overlapping filters never duplicate a source', () => {
    const sources = unwrap(
      applySourceFilters({
        filters: [filter('claude'), filter('claude', 'local')],
        sources: FLEET,
      }),
    )
    expect(sources.map((s) => s.machine)).toEqual(['mac', 'hex', 'm4x'])
  })

  test('rejects a term matching no configured source, naming the term', () => {
    const error = expectError(
      applySourceFilters({
        filters: [filter('hermes', 'local')],
        sources: FLEET,
      }),
    )
    expect(error.message).toContain('--source hermes:local')
    expect(error.message).toContain('matches no configured source')
  })

  test('rejects when any one of several terms matches nothing', () => {
    const result = applySourceFilters({
      filters: [filter('claude'), filter('codex')],
      sources: FLEET,
    })
    expect(CliError.is(result)).toBe(true)
  })
})

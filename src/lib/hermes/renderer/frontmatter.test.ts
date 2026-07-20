import { describe, expect, test } from 'bun:test'

import { type Frontmatter, frontmatterToYaml } from './frontmatter.ts'

function baseFrontmatter(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    sessionId: 'ses_1',
    source: 'discord',
    title: 'Plain title',
    archived: false,
    startedAt: '2026-05-09T12:00:00.000Z',
    endedAt: '2026-05-09T12:00:00.000Z',
    turns: 1,
    platform: {},
    renderer: 'hermes-md@1',
    ...overrides,
  }
}

function line(yaml: string, key: string): string | undefined {
  return yaml.split('\n').find((l) => l.startsWith(key))
}

describe('frontmatterToYaml escaping', () => {
  test('escapes quotes, backslashes and newlines in the title onto one line', () => {
    const yaml = frontmatterToYaml(baseFrontmatter({ title: 'a "q" \\ b\nc' }))

    expect(line(yaml, 'title:')).toBe('title: "a \\"q\\" \\\\ b\\nc"')
    // The raw newline did not split the title across two frontmatter lines.
    expect(yaml.split('\n').filter((l) => l.startsWith('title:'))).toHaveLength(
      1,
    )
    expect(yaml).not.toContain('a "q"')
  })

  test('quotes and escapes a hostile sessionId so it cannot break the block', () => {
    const yaml = frontmatterToYaml(
      baseFrontmatter({ sessionId: 'x"\ninjected: true' }),
    )

    expect(line(yaml, 'sessionId:')).toBe('sessionId: "x\\"\\ninjected: true"')
    // The injected key never lands as its own frontmatter line.
    expect(yaml).not.toContain('\ninjected: true\n')
  })

  test('emits an ordinary sessionId unquoted', () => {
    const yaml = frontmatterToYaml(
      baseFrontmatter({ sessionId: 'ses_abc-123' }),
    )
    expect(yaml).toContain('\nsessionId: ses_abc-123\n')
  })
})

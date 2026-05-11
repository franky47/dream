import { describe, expect, test } from 'bun:test'

import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

function jsonl(...entries: ReadonlyArray<unknown>): string {
  return entries.map((e) => JSON.stringify(e)).join('\n')
}

describe('extractFrontmatter', () => {
  test('pulls sessionId, cwd, and derives project from basename(cwd)', () => {
    const input = jsonl({
      type: 'user',
      sessionId: 'ses_1',
      cwd: '/Users/x/dev/playground/dream',
      timestamp: '2026-05-11T10:00:00Z',
      message: { role: 'user', content: 'hi' },
    })
    const fm = extractFrontmatter(input)
    expect(fm.sessionId).toBe('ses_1')
    expect(fm.cwd).toBe('/Users/x/dev/playground/dream')
    expect(fm.project).toBe('dream')
  })

  test('startedAt and endedAt come from first and last timestamp', () => {
    const input = jsonl(
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'first' },
      },
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:05:30Z',
        message: { role: 'assistant', content: 'reply' },
      },
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:10:00Z',
        message: { role: 'user', content: 'thanks' },
      },
    )
    const fm = extractFrontmatter(input)
    expect(fm.startedAt).toBe('2026-05-11T10:00:00Z')
    expect(fm.endedAt).toBe('2026-05-11T10:10:00Z')
  })

  test('turns counts user entries; toolUses counts tool_use parts', () => {
    const input = jsonl(
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'q1' },
      },
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking out loud' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:02Z',
        message: { role: 'user', content: 'q2' },
      },
    )
    const fm = extractFrontmatter(input)
    expect(fm.turns).toBe(2)
    expect(fm.toolUses).toBe(2)
  })

  describe('title fallback chain', () => {
    test('uses ai-title entry when present', () => {
      const input = jsonl(
        {
          type: 'user',
          sessionId: 'ses_1',
          cwd: '/a',
          timestamp: '2026-05-11T10:00:00Z',
          message: { role: 'user', content: 'long question goes here' },
        },
        {
          type: 'ai-title',
          sessionId: 'ses_1',
          title: 'Concise Title From AI',
        },
      )
      const fm = extractFrontmatter(input)
      expect(fm.title).toBe('Concise Title From AI')
    })

    test('falls back to first 80 chars of first user text when ai-title missing', () => {
      const longText =
        'This is a fairly long first user message that should be truncated at exactly eighty characters or fewer'
      const input = jsonl({
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: longText },
      })
      const fm = extractFrontmatter(input)
      expect(fm.title?.length).toBeLessThanOrEqual(80)
      expect(longText.startsWith(fm.title ?? '')).toBe(true)
    })

    test('strips framing tags from first user text before truncation', () => {
      const framed =
        '<system-reminder>noise</system-reminder>real user intent here'
      const input = jsonl({
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: framed },
      })
      const fm = extractFrontmatter(input)
      expect(fm.title).toBe('real user intent here')
    })

    test("falls back to '(untitled)' when no ai-title and no first user text", () => {
      const input = jsonl({
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'assistant', content: 'hello' },
      })
      const fm = extractFrontmatter(input)
      expect(fm.title).toBe('(untitled)')
    })
  })

  test('renderer version is claude-md@1', () => {
    const fm = extractFrontmatter('')
    expect(fm.renderer).toBe('claude-md@1')
  })

  test('tolerates malformed lines (skips, does not throw)', () => {
    const input = [
      'not json',
      JSON.stringify({
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'ok' },
      }),
      '',
    ].join('\n')
    const fm = extractFrontmatter(input)
    expect(fm.sessionId).toBe('ses_1')
    expect(fm.turns).toBe(1)
  })
})

describe('frontmatterToYaml', () => {
  test('emits stable key order wrapped between --- fences', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/a/dream',
      project: 'dream',
      startedAt: '2026-05-11T10:00:00Z',
      endedAt: '2026-05-11T10:10:00Z',
      turns: 3,
      title: 'A title',
      toolUses: 5,
      renderer: 'claude-md@1',
    })
    expect(yaml.startsWith('---\n')).toBe(true)
    expect(yaml.endsWith('---\n')).toBe(true)
    const body = yaml.slice(4, -4)
    const keys = body
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.split(':')[0])
    expect(keys).toEqual([
      'sessionId',
      'cwd',
      'project',
      'startedAt',
      'endedAt',
      'turns',
      'title',
      'toolUses',
      'renderer',
    ])
  })

  test('quotes title to survive special characters', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/a',
      project: 'a',
      startedAt: '2026-05-11T10:00:00Z',
      endedAt: '2026-05-11T10:00:00Z',
      turns: 1,
      title: 'It said "hello": then it broke',
      toolUses: 0,
      renderer: 'claude-md@1',
    })
    expect(yaml).toContain(`title: "It said \\"hello\\": then it broke"`)
  })
})

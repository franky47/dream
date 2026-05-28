import { describe, expect, test } from 'bun:test'

import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const sessionHeader = {
  type: 'session',
  version: 3,
  id: 'ses_1',
  timestamp: '2026-05-17T09:13:55.629Z',
  cwd: '/repo/dream',
}

function userMsg(id: string, parentId: string | null, text: string): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-05-17T09:15:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantMsg(
  id: string,
  parentId: string | null,
  opts: {
    provider?: string
    modelId?: string
    totalTokens?: number
    cost?: number
  } = {},
): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-05-17T09:15:01.000Z',
    message: {
      role: 'assistant',
      content: [],
      api: 'openai-responses',
      provider: opts.provider ?? 'github-copilot',
      model: opts.modelId ?? 'gpt-5',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: opts.totalTokens ?? 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: opts.cost ?? 0,
        },
      },
    },
  }
}

function modelChange(
  id: string,
  parentId: string | null,
  provider: string,
  modelId: string,
): unknown {
  return {
    type: 'model_change',
    id,
    parentId,
    timestamp: '2026-05-17T09:14:00.000Z',
    provider,
    modelId,
  }
}

function thinkingChange(
  id: string,
  parentId: string | null,
  level: string,
): unknown {
  return {
    type: 'thinking_level_change',
    id,
    parentId,
    timestamp: '2026-05-17T09:14:00.000Z',
    thinkingLevel: level,
  }
}

function toolCallMsg(
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-05-17T09:15:30.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name, arguments: {} }],
    },
  }
}

describe('extractFrontmatter', () => {
  test('pulls sessionId, cwd, version, startedAt from session header', () => {
    const fm = extractFrontmatter(jsonl(sessionHeader))
    expect(fm.sessionId).toBe('ses_1')
    expect(fm.cwd).toBe('/repo/dream')
    expect(fm.version).toBe(3)
    expect(fm.startedAt).toBe('2026-05-17T09:13:55.629Z')
    expect(fm.renderer).toBe('pi-md@1')
  })

  test('parentSession defaults to null when session header has none', () => {
    const fm = extractFrontmatter(jsonl(sessionHeader))
    expect(fm.parentSession).toBeNull()
  })

  test('counts user-role messages on active path as turns', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'hi'),
        assistantMsg('a1', 'u1'),
        userMsg('u2', 'a1', 'follow up'),
        assistantMsg('a2', 'u2'),
      ),
    )
    expect(fm.turns).toBe(2)
  })

  test('counts toolCall content parts on active path as toolUses', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'hi'),
        toolCallMsg('a1', 'u1', 'tc1', 'read'),
        toolCallMsg('a2', 'a1', 'tc2', 'edit'),
      ),
    )
    expect(fm.toolUses).toBe(2)
  })

  test('latestProvider/latestModelId come from last model_change on active path', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionHeader,
        modelChange('m1', null, 'github-copilot', 'gpt-5.4'),
        modelChange('m2', 'm1', 'github-copilot', 'gpt-5-mini'),
      ),
    )
    expect(fm.latestProvider).toBe('github-copilot')
    expect(fm.latestModelId).toBe('gpt-5-mini')
  })

  test('thinkingLevel comes from last thinking_level_change on active path', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionHeader,
        thinkingChange('t1', null, 'off'),
        thinkingChange('t2', 't1', 'medium'),
      ),
    )
    expect(fm.thinkingLevel).toBe('medium')
  })

  test('totalTokens & cost sum across active-path assistant messages', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'q'),
        assistantMsg('a1', 'u1', { totalTokens: 100, cost: 0.001 }),
        userMsg('u2', 'a1', 'q2'),
        assistantMsg('a2', 'u2', { totalTokens: 250, cost: 0.0025 }),
      ),
    )
    expect(fm.totalTokens).toBe(350)
    expect(fm.cost).toBeCloseTo(0.0035, 6)
  })

  test('sessionName comes from session_info.name when present', () => {
    const fm = extractFrontmatter(
      jsonl(sessionHeader, {
        type: 'session_info',
        id: 'si1',
        parentId: null,
        timestamp: '2026-05-17T09:20:00.000Z',
        name: 'my-session',
      }),
    )
    expect(fm.sessionName).toBe('my-session')
  })

  test('off-active-path entries are excluded from counts', () => {
    // Build a tree: u1 → a1, u1 → a2 (branch). a2 is later — active.
    const fm = extractFrontmatter(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'hi'),
        assistantMsg('a1', 'u1'),
        {
          type: 'message',
          id: 'a2',
          parentId: 'u1',
          timestamp: '2026-05-17T09:16:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tc1', name: 'read', arguments: {} },
            ],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 99,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        },
      ),
    )
    // Active leaf: a2 (latest timestamp). Path: u1 → a2.
    expect(fm.turns).toBe(1)
    expect(fm.toolUses).toBe(1)
    expect(fm.totalTokens).toBe(99)
  })
})

describe('frontmatterToYaml', () => {
  test('emits stable key order between --- fences', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/repo/dream',
      version: 3,
      startedAt: '2026-05-17T09:13:55.629Z',
      parentSession: null,
      sessionName: '',
      latestProvider: 'github-copilot',
      latestModelId: 'gpt-5',
      thinkingLevel: 'medium',
      totalTokens: 350,
      cost: 0.0035,
      turns: 2,
      toolUses: 3,
      renderer: 'pi-md@1',
    })
    expect(yaml.startsWith('---\n')).toBe(true)
    expect(yaml.endsWith('---\n')).toBe(true)
    const body = yaml.slice(4, -4)
    const topKeys = body
      .split('\n')
      .filter((l) => l.length > 0 && !l.startsWith(' '))
      .map((l) => l.split(':')[0])
    expect(topKeys).toEqual([
      'sessionId',
      'cwd',
      'version',
      'startedAt',
      'parentSession',
      'sessionName',
      'latestProvider',
      'latestModelId',
      'thinkingLevel',
      'totalTokens',
      'cost',
      'turns',
      'toolUses',
      'renderer',
    ])
  })

  test('renders parentSession: null when absent', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/a',
      version: 3,
      startedAt: '2026-05-17T09:13:55.629Z',
      parentSession: null,
      sessionName: '',
      latestProvider: '',
      latestModelId: '',
      thinkingLevel: '',
      totalTokens: 0,
      cost: 0,
      turns: 0,
      toolUses: 0,
      renderer: 'pi-md@1',
    })
    expect(yaml).toContain('parentSession: null\n')
  })

  test('quotes string fields with special characters', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/path with "quote"',
      version: 3,
      startedAt: '2026-05-17T09:13:55.629Z',
      parentSession: null,
      sessionName: '',
      latestProvider: '',
      latestModelId: '',
      thinkingLevel: '',
      totalTokens: 0,
      cost: 0,
      turns: 0,
      toolUses: 0,
      renderer: 'pi-md@1',
    })
    expect(yaml).toContain('cwd: "/path with \\"quote\\""')
  })
})

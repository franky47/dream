import { describe, expect, test } from 'bun:test'

import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

function sessionRow(extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'session',
    id: 'ses_1',
    sessionId: 'ses_1',
    parentId: null,
    title: 'Some Title',
    directory: '/repo/dream',
    version: '1.0.0',
    time_updated: 1_000,
    project: { id: 'prj_a', worktree: '/repo', vcs: 'git', name: 'dream' },
    workspace: null,
    ...extra,
  }
}

function messageRow(extra: Record<string, unknown>): unknown {
  return {
    type: 'message',
    id: 'msg_x',
    sessionId: 'ses_1',
    role: 'user',
    time: { created: 1_000 },
    ...extra,
  }
}

function partRow(extra: Record<string, unknown>): unknown {
  return {
    type: 'part',
    id: 'prt_x',
    sessionId: 'ses_1',
    messageId: 'msg_x',
    ...extra,
  }
}

describe('extractFrontmatter', () => {
  test('pulls sessionId, directory→cwd, project name', () => {
    const fm = extractFrontmatter(jsonl(sessionRow()))
    expect(fm.sessionId).toBe('ses_1')
    expect(fm.cwd).toBe('/repo/dream')
    expect(fm.project).toBe('dream')
  })

  test('falls back to basename(worktree) when project.name is null', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionRow({
          project: {
            id: 'prj_a',
            worktree: '/repo/other-thing',
            vcs: 'git',
            name: null,
          },
        }),
      ),
    )
    expect(fm.project).toBe('other-thing')
  })

  test('title from session header', () => {
    const fm = extractFrontmatter(jsonl(sessionRow({ title: 'Pull request' })))
    expect(fm.title).toBe('Pull request')
  })

  test('startedAt / endedAt from first and last message time.created (ISO)', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionRow(),
        messageRow({
          id: 'msg_1',
          role: 'user',
          time: { created: Date.parse('2026-05-11T10:00:00Z') },
        }),
        messageRow({
          id: 'msg_2',
          role: 'assistant',
          time: { created: Date.parse('2026-05-11T10:05:30Z') },
        }),
        messageRow({
          id: 'msg_3',
          role: 'user',
          time: { created: Date.parse('2026-05-11T10:10:00Z') },
        }),
      ),
    )
    expect(fm.startedAt).toBe('2026-05-11T10:00:00.000Z')
    expect(fm.endedAt).toBe('2026-05-11T10:10:00.000Z')
  })

  test('turns counts user messages; toolUses counts tool parts', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionRow(),
        messageRow({ id: 'm1', role: 'user' }),
        messageRow({ id: 'm2', role: 'assistant' }),
        partRow({
          id: 'p1',
          messageId: 'm2',
          partType: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'completed', input: {}, output: 'x' },
        }),
        partRow({
          id: 'p2',
          messageId: 'm2',
          partType: 'tool',
          tool: 'read',
          callID: 'c2',
          state: { status: 'completed', input: {}, output: 'y' },
        }),
        messageRow({ id: 'm3', role: 'user' }),
      ),
    )
    expect(fm.turns).toBe(2)
    expect(fm.toolUses).toBe(2)
  })

  test('providerID, modelID, agent from first assistant message', () => {
    const fm = extractFrontmatter(
      jsonl(
        sessionRow(),
        messageRow({ id: 'm1', role: 'user', agent: 'ask' }),
        messageRow({
          id: 'm2',
          role: 'assistant',
          providerID: 'github-copilot',
          modelID: 'gpt-5.4',
          agent: 'ask',
        }),
      ),
    )
    expect(fm.providerID).toBe('github-copilot')
    expect(fm.modelID).toBe('gpt-5.4')
    expect(fm.agent).toBe('ask')
  })

  test('renderer version is opencode-md@1', () => {
    const fm = extractFrontmatter(jsonl(sessionRow()))
    expect(fm.renderer).toBe('opencode-md@1')
  })

  test('tolerates blank lines and malformed lines', () => {
    const input = ['', 'not json', JSON.stringify(sessionRow()), ''].join('\n')
    const fm = extractFrontmatter(input)
    expect(fm.sessionId).toBe('ses_1')
  })
})

describe('frontmatterToYaml', () => {
  test('emits stable key order between --- fences', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/a/dream',
      project: 'dream',
      startedAt: '2026-05-11T10:00:00.000Z',
      endedAt: '2026-05-11T10:10:00.000Z',
      turns: 3,
      title: 'Title',
      toolUses: 5,
      providerID: 'anthropic',
      modelID: 'claude-opus-4-7',
      agent: 'build',
      renderer: 'opencode-md@1',
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
      'providerID',
      'modelID',
      'agent',
      'renderer',
    ])
  })

  test('quotes string fields with special characters', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/a',
      project: 'a',
      startedAt: '2026-05-11T10:00:00.000Z',
      endedAt: '2026-05-11T10:00:00.000Z',
      turns: 1,
      title: 'It said "hi"',
      toolUses: 0,
      providerID: 'anthropic',
      modelID: 'm',
      agent: 'build',
      renderer: 'opencode-md@1',
    })
    expect(yaml).toContain('title: "It said \\"hi\\""')
  })
})

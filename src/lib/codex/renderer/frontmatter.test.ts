import { describe, expect, test } from 'bun:test'

import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

function metaRow(extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: '2026-05-22T18:43:47.456Z',
    type: 'session_meta',
    payload: {
      id: 'ses_1',
      timestamp: '2026-05-22T18:43:24.364Z',
      cwd: '/repo/dream',
      originator: 'Codex Desktop',
      cli_version: '0.133.0-alpha.1',
      model_provider: 'openai',
      git: {
        commit_hash: 'deadbeef',
        branch: 'main',
        repository_url: 'https://example.com/repo.git',
      },
      ...extra,
    },
  }
}

function userMsg(text: string, ts: string): unknown {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  }
}

function assistantMsg(text: string, ts: string): unknown {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  }
}

function fnCall(call_id: string, ts: string): unknown {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      call_id,
      arguments: '{}',
    },
  }
}

describe('extractFrontmatter', () => {
  test('pulls sessionId, cwd, originator, cliVersion, modelProvider from session_meta', () => {
    const fm = extractFrontmatter(jsonl(metaRow()))
    expect(fm.sessionId).toBe('ses_1')
    expect(fm.cwd).toBe('/repo/dream')
    expect(fm.originator).toBe('Codex Desktop')
    expect(fm.cliVersion).toBe('0.133.0-alpha.1')
    expect(fm.modelProvider).toBe('openai')
  })

  test('git is the nested {commit_hash, branch, repository_url} from session_meta', () => {
    const fm = extractFrontmatter(jsonl(metaRow()))
    expect(fm.git).toEqual({
      commitHash: 'deadbeef',
      branch: 'main',
      repositoryUrl: 'https://example.com/repo.git',
    })
  })

  test('git is null when session_meta omits it', () => {
    const fm = extractFrontmatter(jsonl(metaRow({ git: null })))
    expect(fm.git).toBeNull()
  })

  test('startedAt comes from session_meta.payload.timestamp; endedAt from last record wrapper timestamp', () => {
    const fm = extractFrontmatter(
      jsonl(
        metaRow(),
        userMsg('hi', '2026-05-22T18:44:00.000Z'),
        assistantMsg('hello', '2026-05-22T18:45:30.000Z'),
      ),
    )
    expect(fm.startedAt).toBe('2026-05-22T18:43:24.364Z')
    expect(fm.endedAt).toBe('2026-05-22T18:45:30.000Z')
  })

  test('turns counts response_item.message with role=user', () => {
    const fm = extractFrontmatter(
      jsonl(
        metaRow(),
        userMsg('q1', '2026-05-22T18:44:00.000Z'),
        assistantMsg('a1', '2026-05-22T18:44:10.000Z'),
        userMsg('q2', '2026-05-22T18:45:00.000Z'),
        assistantMsg('a2', '2026-05-22T18:45:10.000Z'),
      ),
    )
    expect(fm.turns).toBe(2)
  })

  test('toolUses counts function_call + custom_tool_call records', () => {
    const fm = extractFrontmatter(
      jsonl(
        metaRow(),
        fnCall('c1', '2026-05-22T18:44:00.000Z'),
        fnCall('c2', '2026-05-22T18:44:01.000Z'),
        {
          timestamp: '2026-05-22T18:44:02.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'apply_patch',
            call_id: 'c3',
            input: '*** Begin Patch',
          },
        },
      ),
    )
    expect(fm.toolUses).toBe(3)
  })

  test('renderer version is codex-md@1', () => {
    const fm = extractFrontmatter(jsonl(metaRow()))
    expect(fm.renderer).toBe('codex-md@1')
  })

  test('tolerates blank lines and malformed lines', () => {
    const input = ['', 'not json', JSON.stringify(metaRow()), ''].join('\n')
    const fm = extractFrontmatter(input)
    expect(fm.sessionId).toBe('ses_1')
  })
})

describe('frontmatterToYaml', () => {
  test('emits stable key order between --- fences', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/repo/dream',
      startedAt: '2026-05-22T18:43:24.364Z',
      endedAt: '2026-05-22T18:45:30.000Z',
      turns: 2,
      toolUses: 3,
      originator: 'Codex Desktop',
      cliVersion: '0.133.0-alpha.1',
      modelProvider: 'openai',
      git: {
        commitHash: 'deadbeef',
        branch: 'main',
        repositoryUrl: 'https://example.com/repo.git',
      },
      renderer: 'codex-md@1',
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
      'startedAt',
      'endedAt',
      'turns',
      'toolUses',
      'originator',
      'cliVersion',
      'modelProvider',
      'git',
      'renderer',
    ])
  })

  test('renders git as a nested object with indented snake_case keys', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/a',
      startedAt: '2026-05-22T18:43:24.364Z',
      endedAt: '2026-05-22T18:43:24.364Z',
      turns: 0,
      toolUses: 0,
      originator: 'Codex Desktop',
      cliVersion: '0',
      modelProvider: 'openai',
      git: {
        commitHash: 'deadbeef',
        branch: 'main',
        repositoryUrl: 'https://example.com/repo.git',
      },
      renderer: 'codex-md@1',
    })
    expect(yaml).toContain('git:\n')
    expect(yaml).toContain('  commit_hash: "deadbeef"\n')
    expect(yaml).toContain('  branch: "main"\n')
    expect(yaml).toContain('  repository_url: "https://example.com/repo.git"\n')
  })

  test('renders git: null when absent', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/a',
      startedAt: '2026-05-22T18:43:24.364Z',
      endedAt: '2026-05-22T18:43:24.364Z',
      turns: 0,
      toolUses: 0,
      originator: 'Codex Desktop',
      cliVersion: '0',
      modelProvider: 'openai',
      git: null,
      renderer: 'codex-md@1',
    })
    expect(yaml).toContain('git: null\n')
  })

  test('quotes string fields with special characters', () => {
    const yaml = frontmatterToYaml({
      sessionId: 'ses_1',
      cwd: '/path with "quote"',
      startedAt: '2026-05-22T18:43:24.364Z',
      endedAt: '2026-05-22T18:43:24.364Z',
      turns: 0,
      toolUses: 0,
      originator: 'x',
      cliVersion: '0',
      modelProvider: 'openai',
      git: null,
      renderer: 'codex-md@1',
    })
    expect(yaml).toContain('cwd: "/path with \\"quote\\""')
  })
})

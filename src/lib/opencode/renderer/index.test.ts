import { describe, expect, test } from 'bun:test'

import { renderOpencodeSession } from './index.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const session = {
  type: 'session',
  id: 'ses_1',
  sessionId: 'ses_1',
  title: 'Demo',
  directory: '/repo/dream',
  project: { id: 'p', worktree: '/repo', vcs: 'git', name: 'dream' },
}

describe('renderOpencodeSession', () => {
  test('renders a small session end-to-end with frontmatter, turn markers, and tool fallback', () => {
    const input = jsonl(
      session,
      {
        type: 'message',
        id: 'm1',
        sessionId: 'ses_1',
        role: 'user',
        time: { created: Date.parse('2026-05-11T10:00:00Z') },
        agent: 'build',
      },
      {
        type: 'part',
        id: 'p1',
        sessionId: 'ses_1',
        messageId: 'm1',
        partType: 'text',
        text: 'list files',
      },
      {
        type: 'message',
        id: 'm2',
        sessionId: 'ses_1',
        role: 'assistant',
        time: { created: Date.parse('2026-05-11T10:00:30Z') },
        providerID: 'anthropic',
        modelID: 'claude-opus-4-7',
        agent: 'build',
      },
      {
        type: 'part',
        id: 'p2',
        sessionId: 'ses_1',
        messageId: 'm2',
        partType: 'tool',
        tool: 'bash',
        callID: 'c1',
        state: {
          status: 'completed',
          input: { command: 'ls' },
          output: 'a\nb',
        },
      },
    )

    const out = renderOpencodeSession(input)

    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('sessionId: ses_1')
    expect(out).toContain('renderer: "opencode-md@1"')
    expect(out).toContain('<turn n="1" role="user" t="0"/>')
    expect(out).toContain('list files')
    expect(out).toContain('<turn n="2" role="assistant" t="+0m30s"/>')
    expect(out).toContain('<tool name="bash" command="ls"/>')
    expect(out.endsWith('\n')).toBe(true)
  })
})

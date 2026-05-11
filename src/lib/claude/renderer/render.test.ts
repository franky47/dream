import { describe, expect, test } from 'bun:test'

import { renderClaudeSession } from './render.ts'

function jsonl(...entries: ReadonlyArray<unknown>): string {
  return entries.map((e) => JSON.stringify(e)).join('\n')
}

function bodyOf(rendered: string): string {
  const fenceEnd = rendered.indexOf('---\n', 4)
  return rendered.slice(fenceEnd + 4)
}

describe('renderClaudeSession', () => {
  test('emits YAML frontmatter then body separated by a blank line', () => {
    const input = jsonl({
      type: 'user',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: { role: 'user', content: 'hello' },
    })
    const out = renderClaudeSession(input)
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('\n---\n\n')
  })

  test('single user entry emits one turn marker with t="0"', () => {
    const input = jsonl({
      type: 'user',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: { role: 'user', content: 'hello' },
    })
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('<turn n="1" role="user" t="0"/>')
    expect(body).toContain('hello')
  })

  test('subsequent turns carry +MMmSSs deltas from timestamps', () => {
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
        timestamp: '2026-05-11T10:04:12Z',
        message: { role: 'assistant', content: 'reply' },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('<turn n="1" role="user" t="0"/>')
    expect(body).toContain('<turn n="2" role="assistant" t="+4m12s"/>')
  })

  test('tool_use renders as self-closing <tool name="..." .../>', () => {
    const input = jsonl(
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'go' },
      },
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading' },
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/x/y.ts' },
            },
          ],
        },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('<tool name="Read" file_path="/x/y.ts"/>')
  })

  test('drops assistant thinking blocks', () => {
    const input = jsonl(
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'go' },
      },
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'should not appear' },
            { type: 'text', text: 'visible reply' },
          ],
        },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).not.toContain('should not appear')
    expect(body).toContain('visible reply')
  })

  test('drops low-signal meta entries entirely', () => {
    const droppedTypes = [
      'file-history-snapshot',
      'last-prompt',
      'permission-mode',
      'queue-operation',
      'attachment',
      'system',
    ]
    const input = jsonl(
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'go' },
      },
      ...droppedTypes.map((t) => ({
        type: t,
        sessionId: 'ses_1',
        marker: 'DROP_ME_PLEASE',
      })),
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).not.toContain('DROP_ME_PLEASE')
  })

  test('strips <system-reminder> and <command-*> framing from user text', () => {
    const framed =
      'real intent <system-reminder>noise</system-reminder> here <command-name>x</command-name>'
    const input = jsonl({
      type: 'user',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: { role: 'user', content: framed },
    })
    const body = bodyOf(renderClaudeSession(input))
    expect(body).not.toContain('system-reminder')
    expect(body).not.toContain('command-name')
    expect(body).toContain('real intent')
    expect(body).toContain('here')
  })

  test('slash-command invocations surface as one-line [/skill args="..."]', () => {
    const cmd =
      '<command-name>/review</command-name><command-args>HEAD~1</command-args>'
    const input = jsonl({
      type: 'user',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: { role: 'user', content: cmd },
    })
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('[/review args="HEAD~1"]')
  })
})

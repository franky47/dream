import { describe, expect, test } from 'bun:test'

import { renderClaudeSession } from './index.ts'

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
    expect(body).toContain('<tool name="Read" path="/x/y.ts"/>')
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

  test('Bash tool_use renders self-closing with cmd; error="1" on is_error', () => {
    const input = jsonl(
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: { role: 'user', content: 'run it' },
      },
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:01Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'echo hi' },
            },
            {
              type: 'tool_use',
              id: 'toolu_2',
              name: 'Bash',
              input: { command: 'false' },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:02Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'hi',
              is_error: false,
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: 'oops',
              is_error: true,
            },
          ],
        },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('<tool name="Bash" cmd="echo hi"/>')
    expect(body).toContain('<tool name="Bash" cmd="false" error="1"/>')
    expect(body).not.toContain('hi\n</tool>')
    expect(body).not.toContain('oops')
  })

  test('Write tool_use renders self-closing with file + lines + bytes', () => {
    const input = jsonl({
      type: 'assistant',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_w',
            name: 'Write',
            input: {
              file_path: '/x/new.ts',
              content: 'export const x = 1\n',
            },
          },
        ],
      },
    })
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain(
      '<tool name="Write" file="/x/new.ts" lines="1" bytes="19"/>',
    )
    expect(body).not.toContain('export const x = 1')
  })

  test('consecutive same-file Edits coalesce into one element with summed added/removed', () => {
    const input = jsonl({
      type: 'assistant',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'e1',
            name: 'Edit',
            input: {
              file_path: '/x/y.ts',
              old_string: 'alpha',
              new_string: 'ALPHA',
            },
          },
          {
            type: 'tool_use',
            id: 'e2',
            name: 'Edit',
            input: {
              file_path: '/x/y.ts',
              old_string: 'beta',
              new_string: 'BETA',
            },
          },
        ],
      },
    })
    const body = bodyOf(renderClaudeSession(input))
    const editOpens = body.match(/<tool name="Edit"/g) ?? []
    expect(editOpens.length).toBe(1)
    expect(body).toContain('patches="2"')
    expect(body).toContain('added="2"')
    expect(body).toContain('removed="2"')
    expect(body).not.toContain('-alpha')
    expect(body).not.toContain('+ALPHA')
  })

  test('same-file Edits separated by a different tool do NOT coalesce', () => {
    const input = jsonl({
      type: 'assistant',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'e1',
            name: 'Edit',
            input: {
              file_path: '/x/y.ts',
              old_string: 'alpha',
              new_string: 'ALPHA',
            },
          },
          {
            type: 'tool_use',
            id: 'r1',
            name: 'Read',
            input: { file_path: '/other.ts' },
          },
          {
            type: 'tool_use',
            id: 'e2',
            name: 'Edit',
            input: {
              file_path: '/x/y.ts',
              old_string: 'beta',
              new_string: 'BETA',
            },
          },
        ],
      },
    })
    const body = bodyOf(renderClaudeSession(input))
    const editOpens = body.match(/<tool name="Edit"/g) ?? []
    expect(editOpens.length).toBe(2)
    expect(body).not.toContain('patches="2"')
    expect(body).toContain('patches="1"')
  })

  test('same-file Edits across consecutive assistant turns coalesce', () => {
    const input = jsonl(
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'e1',
              name: 'Edit',
              input: {
                file_path: '/x/y.ts',
                old_string: 'one',
                new_string: 'ONE',
              },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:01Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }],
        },
      },
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:02Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'e2',
              name: 'Edit',
              input: {
                file_path: '/x/y.ts',
                old_string: 'two',
                new_string: 'TWO',
              },
            },
          ],
        },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    const editOpens = body.match(/<tool name="Edit"/g) ?? []
    expect(editOpens.length).toBe(1)
    expect(body).toContain('patches="2"')
  })

  test('different-file consecutive Edits do NOT coalesce', () => {
    const input = jsonl({
      type: 'assistant',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: '2026-05-11T10:00:00Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'e1',
            name: 'Edit',
            input: {
              file_path: '/a.ts',
              old_string: 'x',
              new_string: 'X',
            },
          },
          {
            type: 'tool_use',
            id: 'e2',
            name: 'Edit',
            input: {
              file_path: '/b.ts',
              old_string: 'y',
              new_string: 'Y',
            },
          },
        ],
      },
    })
    const body = bodyOf(renderClaudeSession(input))
    const editOpens = body.match(/<tool name="Edit"/g) ?? []
    expect(editOpens.length).toBe(2)
  })

  test('no-op TodoWrite self-closes', () => {
    const todoCall = (id: string, ts: string) => ({
      type: 'assistant',
      sessionId: 'ses_1',
      cwd: '/a',
      timestamp: ts,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id,
            name: 'TodoWrite',
            input: { todos: [{ content: 'X', status: 'pending' }] },
          },
        ],
      },
    })
    const input = jsonl(
      todoCall('t1', '2026-05-11T10:00:00Z'),
      todoCall('t2', '2026-05-11T10:00:01Z'),
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('<tool name="TodoWrite"/>')
  })

  test('TodoWrite emits state diff between adjacent calls', () => {
    const input = jsonl(
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:00Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tw1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'a', status: 'pending' },
                  { content: 'b', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: '2026-05-11T10:00:01Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tw2',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'a', status: 'in_progress' },
                  { content: 'b', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('<tool name="TodoWrite">')
    expect(body).toContain('+ "a"')
    expect(body).toContain('"a" → in_progress')
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

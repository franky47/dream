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

  test('Bash tool_use renders with cmd + exit attrs and body from tool_result', () => {
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
          ],
        },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toContain('<tool name="Bash" cmd="echo hi" exit="0">')
    expect(body).toContain('hi')
    expect(body).toContain('</tool>')
  })

  test('Write tool_use renders with file + lines + bytes attrs', () => {
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
      '<tool name="Write" file="/x/new.ts" lines="1" bytes="19">',
    )
    expect(body).toContain('export const x = 1')
  })

  test('consecutive same-file Edits coalesce into one element with patches=N', () => {
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
    expect(body).toContain('-alpha')
    expect(body).toContain('+ALPHA')
    expect(body).toContain('-beta')
    expect(body).toContain('+BETA')
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

  test('dedups identical tool_result bodies in same session', () => {
    const callBash = (id: string, ts: string) => [
      {
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
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'ses_1',
        cwd: '/a',
        timestamp: ts,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: 'foo\nbar\nbaz',
              is_error: false,
            },
          ],
        },
      },
    ]
    const input = jsonl(
      ...callBash('t1', '2026-05-11T10:00:00Z'),
      ...callBash('t2', '2026-05-11T10:00:02Z'),
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).toMatch(/<tool name="Bash" cmd="ls" exit="0">\nfoo\nbar\nbaz/)
    expect(body).toContain('(same output as turn 1)')
  })

  test('Write tool bodies are not dedup-collapsed across turns', () => {
    const writeCall = (id: string, ts: string, file: string) => ({
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
            name: 'Write',
            input: { file_path: file, content: 'export const x = 1\n' },
          },
        ],
      },
    })
    const input = jsonl(
      writeCall('w1', '2026-05-11T10:00:00Z', '/a.ts'),
      writeCall('w2', '2026-05-11T10:00:01Z', '/b.ts'),
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).not.toContain('(same output as turn')
    expect(body.match(/export const x = 1/g)?.length).toBe(2)
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
    expect(body).not.toContain('(same output as turn')
  })

  test('strips ANSI from tool bodies and collapses blank runs', () => {
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
              id: 'b1',
              name: 'Bash',
              input: { command: 'cargo test' },
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
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b1',
              content: '\x1b[31mfail\x1b[0m   \n\n\n\n\nend',
              is_error: true,
            },
          ],
        },
      },
    )
    const body = bodyOf(renderClaudeSession(input))
    expect(body).not.toContain('\x1b[')
    expect(body).toContain('fail')
    expect(body).toContain('end')
    expect(body).not.toMatch(/\n\n\n/)
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

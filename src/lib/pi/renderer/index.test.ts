import { describe, expect, test } from 'bun:test'

import { renderPiSession } from './index.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const sessionHeader = {
  type: 'session',
  version: 3,
  id: 'ses_1',
  timestamp: '2026-05-17T09:13:55.629Z',
  cwd: '/repo',
}

describe('renderPiSession', () => {
  test('renders frontmatter + turn markers + text + tool fallback end-to-end', () => {
    const input = jsonl(
      sessionHeader,
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-17T09:15:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'list files' }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-17T09:15:30.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc1',
              name: 'read',
              arguments: { path: '/x' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'r1',
        parentId: 'a1',
        timestamp: '2026-05-17T09:15:31.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tc1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file body' }],
        },
      },
    )

    const out = renderPiSession(input)

    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('sessionId: ses_1')
    expect(out).toContain('renderer: "pi-md@1"')
    expect(out).toContain('<turn n="1" role="user" t="0"/>')
    expect(out).toContain('list files')
    expect(out).toContain('<turn n="2" role="assistant" t="+0m30s"/>')
    expect(out).toContain('<tool name="read" path="/x"/>')
    expect(out.endsWith('\n')).toBe(true)
  })

  test('bashExecution renders as a user-turn tool with bashExecution name and excludeFromContext flag', () => {
    const input = jsonl(sessionHeader, {
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-05-17T09:15:00.000Z',
      message: {
        role: 'bashExecution',
        command: 'ls',
        output: 'a\nb\n',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 0,
        excludeFromContext: true,
      },
    })

    const out = renderPiSession(input)
    expect(out).toContain('<turn n="1" role="user"')
    expect(out).toContain(
      '<tool name="bashExecution" command="ls" exitCode="0" excludeFromContext="true"/>',
    )
  })

  test('custom_message routes through the fallback renderer', () => {
    const input = jsonl(sessionHeader, {
      type: 'custom_message',
      customType: 'pi-splash',
      content: 'hello',
      display: true,
      id: 'cm1',
      parentId: null,
      timestamp: '2026-05-17T09:14:00.000Z',
    })

    const out = renderPiSession(input)
    expect(out).toContain('<tool name="pi-splash"')
    expect(out).toContain('content="hello"')
  })
})

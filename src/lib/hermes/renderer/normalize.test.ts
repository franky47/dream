import { describe, expect, test } from 'bun:test'

import type { NormalizedSession, Part, ToolPart } from '#lib/renderer/types'

import { normalize } from './normalize.ts'

function jsonl(rows: ReadonlyArray<object>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function textRow(role: string, content: string, createdAt: number): object {
  return { type: 'message', role, content, createdAt }
}

function toolCallRow(
  call: { callId: string; name: string; input?: Record<string, unknown> },
  createdAt: number,
): object {
  return {
    type: 'message',
    role: 'assistant',
    content: JSON.stringify({ type: 'tool_call', ...call }),
    createdAt,
  }
}

function toolResultRow(
  result: {
    callId: string
    output?: string
    isError?: boolean
    details?: unknown
  },
  createdAt: number,
): object {
  return {
    type: 'message',
    role: 'tool',
    content: JSON.stringify({ type: 'tool_result', ...result }),
    createdAt,
  }
}

function isToolPart(part: Part): part is ToolPart {
  return part.kind === 'tool'
}

function toolParts(session: NormalizedSession): ToolPart[] {
  return session.messages.flatMap((m) => m.parts.filter(isToolPart))
}

describe('normalize tool pairing', () => {
  test('pairs a tool-call row with its result by call id', () => {
    const session = normalize(
      jsonl([
        toolCallRow({ callId: 'c1', name: 'read', input: { path: '/x' } }, 1),
        toolResultRow({ callId: 'c1', output: 'file body' }, 2),
      ]),
    )

    const tools = toolParts(session)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.id).toBe('c1')
    expect(tools[0]?.name).toBe('read')
    expect(tools[0]?.input).toEqual({ path: '/x' })
    expect(tools[0]?.result).toEqual({
      content: 'file body',
      isError: false,
      details: undefined,
    })
  })

  test('keeps message order and attaches the tool to the assistant turn', () => {
    const session = normalize(
      jsonl([
        textRow('user', 'run ls', 1),
        toolCallRow(
          { callId: 'c1', name: 'terminal', input: { command: 'ls' } },
          2,
        ),
        toolResultRow({ callId: 'c1', output: 'a\nb' }, 3),
        textRow('assistant', 'done', 4),
      ]),
    )

    expect(session.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ])
    const assistantWithTool = session.messages[1]
    expect(assistantWithTool?.parts[0]).toMatchObject({
      kind: 'tool',
      name: 'terminal',
    })
  })

  test('marks a failed tool result as an error', () => {
    const session = normalize(
      jsonl([
        toolCallRow(
          { callId: 'c1', name: 'terminal', input: { command: 'x' } },
          1,
        ),
        toolResultRow({ callId: 'c1', output: 'boom', isError: true }, 2),
      ]),
    )
    expect(toolParts(session)[0]?.result?.isError).toBe(true)
  })

  test('leaves an unmatched result harmless', () => {
    const session = normalize(
      jsonl([toolResultRow({ callId: 'orphan', output: 'x' }, 1)]),
    )
    expect(toolParts(session)).toHaveLength(0)
    expect(session.messages).toHaveLength(0)
  })

  test('defaults missing tool-call input to an empty object', () => {
    const session = normalize(
      jsonl([toolCallRow({ callId: 'c1', name: 'todo' }, 1)]),
    )
    expect(toolParts(session)[0]?.input).toEqual({})
  })

  test('drops a malformed tool envelope instead of leaking its raw JSON', () => {
    const malformed = {
      type: 'message',
      role: 'tool',
      content: JSON.stringify({ type: 'tool_result', output: 42 }),
      createdAt: 1,
    }
    const session = normalize(jsonl([malformed]))
    expect(session.messages).toHaveLength(0)
    expect(toolParts(session)).toHaveLength(0)
  })

  test('treats plain-text content as a message, not a tool', () => {
    const session = normalize(jsonl([textRow('user', 'hello there', 1)]))
    expect(toolParts(session)).toHaveLength(0)
    expect(session.messages[0]?.parts[0]).toEqual({
      kind: 'text',
      text: 'hello there',
    })
  })
})

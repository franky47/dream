import { describe, expect, test } from 'bun:test'

import type { NormalizedSession, Part, ToolPart } from '#lib/renderer/types'

import { normalize } from './normalize.ts'

function jsonl(rows: ReadonlyArray<object>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function textRow(role: string, content: string, createdAt: number): object {
  return { type: 'message', role, content, createdAt }
}

// An assistant turn stores its tool invocations inline as an OpenAI-shaped
// `tool_calls` array; the arguments are a JSON string.
function toolCallRow(
  call: { callId: string; name: string; input?: Record<string, unknown> },
  createdAt: number,
  content: string | null = null,
): object {
  return {
    type: 'message',
    role: 'assistant',
    content,
    createdAt,
    toolCalls: [
      {
        id: call.callId,
        call_id: call.callId,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        },
      },
    ],
  }
}

// A tool result is a later `role='tool'` row keyed by `tool_call_id`; its content
// is a JSON object such as `{"output":"..."}` or `{"success":false,...}`.
function toolResultRow(
  result: { callId: string; output?: string; isError?: boolean },
  createdAt: number,
): object {
  const body = result.isError
    ? { success: false, output: result.output }
    : { output: result.output }
  return {
    type: 'message',
    role: 'tool',
    toolCallId: result.callId,
    content: JSON.stringify(body),
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
        toolCallRow(
          { callId: 'c1', name: 'terminal', input: { command: 'x' } },
          1,
        ),
        toolResultRow({ callId: 'c1', output: 'file body' }, 2),
      ]),
    )

    const tools = toolParts(session)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.id).toBe('c1')
    expect(tools[0]?.name).toBe('terminal')
    expect(tools[0]?.input).toEqual({ command: 'x' })
    expect(tools[0]?.result).toMatchObject({
      content: 'file body',
      isError: false,
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

  test('renders assistant text and its inline tool call in one turn', () => {
    const session = normalize(
      jsonl([
        toolCallRow(
          { callId: 'c1', name: 'terminal', input: { command: 'ls' } },
          1,
          'Let me list the files.',
        ),
      ]),
    )

    const message = session.messages[0]
    expect(message?.parts[0]).toEqual({
      kind: 'text',
      text: 'Let me list the files.',
    })
    expect(message?.parts[1]).toMatchObject({ kind: 'tool', name: 'terminal' })
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

  test('defaults missing tool-call arguments to an empty object', () => {
    const session = normalize(
      jsonl([toolCallRow({ callId: 'c1', name: 'skill_view' }, 1)]),
    )
    expect(toolParts(session)[0]?.input).toEqual({})
  })

  test('a tool row never emits a standalone message', () => {
    const session = normalize(
      jsonl([
        {
          type: 'message',
          role: 'tool',
          toolCallId: 'orphan',
          content: 'not json at all',
          createdAt: 1,
        },
      ]),
    )
    expect(session.messages).toHaveLength(0)
  })

  test('treats plain-text content as a message, not a tool', () => {
    const session = normalize(jsonl([textRow('user', 'hello there', 1)]))
    expect(toolParts(session)).toHaveLength(0)
    expect(session.messages[0]?.parts[0]).toEqual({
      kind: 'text',
      text: 'hello there',
    })
  })

  test('skips empty session_meta rows', () => {
    const session = normalize(
      jsonl([
        { type: 'message', role: 'session_meta', content: '', createdAt: 1 },
        textRow('user', 'real message', 2),
      ]),
    )
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]?.role).toBe('user')
  })
})

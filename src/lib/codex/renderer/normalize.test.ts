import { describe, expect, test } from 'bun:test'

import type { Part, ToolPart } from '#lib/renderer/types'

import { normalize } from './normalize.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

function firstToolPart(parts: ReadonlyArray<Part> | undefined): ToolPart {
  const p = parts?.[0]
  if (p === undefined || p.kind !== 'tool') {
    throw new Error(
      `expected first part to be a tool, got ${p?.kind ?? 'none'}`,
    )
  }
  return p
}

const meta = {
  timestamp: '2026-05-22T18:43:47.456Z',
  type: 'session_meta',
  payload: {
    id: 'ses_1',
    timestamp: '2026-05-22T18:43:24.364Z',
    cwd: '/repo',
    originator: 'Codex Desktop',
    cli_version: '0.1.0',
    model_provider: 'openai',
    git: null,
  },
}

function msg(
  role: 'user' | 'assistant' | 'developer',
  text: string,
  ts = '2026-05-22T18:44:00.000Z',
): unknown {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [
        { type: role === 'assistant' ? 'output_text' : 'input_text', text },
      ],
    },
  }
}

function fnCall(
  name: string,
  callId: string,
  args: string,
  ts = '2026-05-22T18:44:01.000Z',
): unknown {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call', name, call_id: callId, arguments: args },
  }
}

function fnOut(
  callId: string,
  output: string,
  ts = '2026-05-22T18:44:02.000Z',
): unknown {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output },
  }
}

describe('normalize', () => {
  test('produces NormalizedSession with frontmatterYaml and ordered messages', () => {
    const out = normalize(
      jsonl(
        meta,
        msg('user', 'hi', '2026-05-22T18:44:00.000Z'),
        msg('assistant', 'hello', '2026-05-22T18:44:05.000Z'),
      ),
    )
    expect(out.frontmatterYaml).toContain('sessionId: ses_1')
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0]?.role).toBe('user')
    expect(out.messages[0]?.timestampMs).toBe(
      Date.parse('2026-05-22T18:44:00.000Z'),
    )
    expect(out.messages[0]?.parts).toEqual([{ kind: 'text', text: 'hi' }])
    expect(out.messages[1]?.role).toBe('assistant')
    expect(out.messages[1]?.parts).toEqual([{ kind: 'text', text: 'hello' }])
  })

  test('developer-role messages are kept as user role', () => {
    const out = normalize(jsonl(meta, msg('developer', 'instructions')))
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
    expect(out.messages[0]?.parts).toEqual([
      { kind: 'text', text: 'instructions' },
    ])
  })

  test('groups consecutive assistant items (message + function_call) into one assistant message', () => {
    const out = normalize(
      jsonl(
        meta,
        msg('user', 'do it'),
        msg('assistant', 'on it', '2026-05-22T18:44:05.000Z'),
        fnCall(
          'exec_command',
          'c1',
          '{"cmd":"ls"}',
          '2026-05-22T18:44:06.000Z',
        ),
        fnOut('c1', 'a\nb', '2026-05-22T18:44:07.000Z'),
      ),
    )
    expect(out.messages).toHaveLength(2)
    expect(out.messages[1]?.role).toBe('assistant')
    expect(out.messages[1]?.parts).toEqual([
      { kind: 'text', text: 'on it' },
      {
        kind: 'tool',
        id: 'c1',
        name: 'exec_command',
        input: { cmd: 'ls' },
        result: { content: 'a\nb', isError: false },
      },
    ])
  })

  test('function_call without paired output has undefined result', () => {
    const out = normalize(
      jsonl(meta, fnCall('exec_command', 'c1', '{"cmd":"ls"}')),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.result).toBeUndefined()
  })

  test('function_call with non-JSON arguments stores raw string under _raw', () => {
    const out = normalize(jsonl(meta, fnCall('exec_command', 'c1', 'not json')))
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.input).toEqual({ _raw: 'not json' })
  })

  test('custom_tool_call pairs with custom_tool_call_output by call_id', () => {
    const out = normalize(
      jsonl(
        meta,
        {
          timestamp: '2026-05-22T18:44:00.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'apply_patch',
            call_id: 'cp1',
            input: '*** Begin Patch\n*** End Patch',
          },
        },
        {
          timestamp: '2026-05-22T18:44:01.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'cp1',
            output: 'Success',
          },
        },
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.name).toBe('apply_patch')
    expect(tool.input).toEqual({ _raw: '*** Begin Patch\n*** End Patch' })
    expect(tool.result).toEqual({ content: 'Success', isError: false })
  })

  test('MCP function_call output is reconciled from event_msg.mcp_tool_call_end when present', () => {
    const out = normalize(
      jsonl(
        meta,
        fnCall('mcp__server__do_thing', 'c1', '{"x":1}'),
        fnOut('c1', 'string-output', '2026-05-22T18:44:02.000Z'),
        {
          timestamp: '2026-05-22T18:44:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'mcp_tool_call_end',
            call_id: 'c1',
            result: { ok: true, data: [1, 2, 3] },
          },
        },
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.name).toBe('mcp__server__do_thing')
    expect(tool.result).toEqual({
      content: JSON.stringify({ ok: true, data: [1, 2, 3] }),
      isError: false,
    })
  })

  test('MCP reconciliation works regardless of event order (mcp_tool_call_end before function_call_output)', () => {
    const out = normalize(
      jsonl(
        meta,
        fnCall('mcp__server__do_thing', 'c1', '{}'),
        {
          timestamp: '2026-05-22T18:44:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'mcp_tool_call_end',
            call_id: 'c1',
            result: { ok: true },
          },
        },
        fnOut('c1', 'plain string', '2026-05-22T18:44:03.000Z'),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.result).toEqual({
      content: JSON.stringify({ ok: true }),
      isError: false,
    })
  })

  test('message with mixed content (text + image attachment) renders the text portion', () => {
    const out = normalize(
      jsonl(meta, {
        timestamp: '2026-05-22T18:44:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'see this' },
            { type: 'input_image', image_url: 'data:...' },
          ],
        },
      }),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.parts).toEqual([{ kind: 'text', text: 'see this' }])
  })

  test('MCP function_call without paired mcp_tool_call_end falls back to string function_call_output', () => {
    const out = normalize(
      jsonl(
        meta,
        fnCall('mcp__server__do_thing', 'c1', '{}'),
        fnOut('c1', 'plain string', '2026-05-22T18:44:02.000Z'),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.result).toEqual({ content: 'plain string', isError: false })
  })

  test('drops event_msg.agent_message, event_msg.token_count, lifecycle events', () => {
    const out = normalize(
      jsonl(
        meta,
        msg('user', 'q'),
        {
          timestamp: '2026-05-22T18:44:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'dup',
            phase: 'commentary',
          },
        },
        {
          timestamp: '2026-05-22T18:44:02.000Z',
          type: 'event_msg',
          payload: { type: 'token_count', info: {} },
        },
        {
          timestamp: '2026-05-22T18:44:03.000Z',
          type: 'event_msg',
          payload: { type: 'task_started' },
        },
        {
          timestamp: '2026-05-22T18:44:04.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete' },
        },
        {
          timestamp: '2026-05-22T18:44:05.000Z',
          type: 'event_msg',
          payload: { type: 'turn_aborted' },
        },
      ),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
  })

  test('drops empty reasoning entries (summary=[] and content=null)', () => {
    const out = normalize(
      jsonl(meta, msg('user', 'q'), {
        timestamp: '2026-05-22T18:44:01.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          content: null,
          encrypted_content: 'xxxx',
        },
      }),
    )
    expect(out.messages).toHaveLength(1)
  })

  test('keeps reasoning entries with non-empty summary as assistant text part', () => {
    const out = normalize(
      jsonl(meta, msg('user', 'q'), {
        timestamp: '2026-05-22T18:44:01.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thinking out loud' }],
          content: null,
        },
      }),
    )
    expect(out.messages).toHaveLength(2)
    expect(out.messages[1]?.role).toBe('assistant')
    expect(out.messages[1]?.parts).toEqual([
      { kind: 'text', text: 'thinking out loud' },
    ])
  })

  test('drops turn_context and session_meta from messages', () => {
    const out = normalize(
      jsonl(meta, {
        timestamp: '2026-05-22T18:43:48.000Z',
        type: 'turn_context',
        payload: { turn_id: 't1', cwd: '/x' },
      }),
    )
    expect(out.messages).toEqual([])
  })

  test('multi-content message concatenates text parts with newlines', () => {
    const out = normalize(
      jsonl(meta, {
        timestamp: '2026-05-22T18:44:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'line one' },
            { type: 'output_text', text: 'line two' },
          ],
        },
      }),
    )
    expect(out.messages[0]?.parts).toEqual([
      { kind: 'text', text: 'line one\nline two' },
    ])
  })
})

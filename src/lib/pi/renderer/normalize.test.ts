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

const sessionHeader = {
  type: 'session',
  version: 3,
  id: 'ses_1',
  timestamp: '2026-05-17T09:13:55.629Z',
  cwd: '/repo',
}

function userMsg(
  id: string,
  parentId: string | null,
  text: string,
  ts = '2026-05-17T09:15:00.000Z',
): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantText(
  id: string,
  parentId: string | null,
  text: string,
  ts = '2026-05-17T09:15:01.000Z',
): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

function toolCallMsg(
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
  ts = '2026-05-17T09:15:30.000Z',
): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name, arguments: args }],
    },
  }
}

function toolResultMsg(
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
  resultText: string,
  ts = '2026-05-17T09:15:31.000Z',
): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: name,
      content: [{ type: 'text', text: resultText }],
    },
  }
}

function bashExec(
  id: string,
  parentId: string | null,
  command: string,
  output: string,
  opts: { exitCode?: number; excludeFromContext?: boolean } = {},
  ts = '2026-05-17T09:15:10.000Z',
): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: {
      role: 'bashExecution',
      command,
      output,
      exitCode: opts.exitCode ?? 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
      excludeFromContext: opts.excludeFromContext ?? false,
    },
  }
}

describe('normalize', () => {
  test('returns frontmatter YAML and a linear active-path transcript', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'hi'),
        assistantText('a1', 'u1', 'hello'),
      ),
    )
    expect(out.frontmatterYaml).toContain('sessionId: ses_1')
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0]?.role).toBe('user')
    expect(out.messages[0]?.parts).toEqual([{ kind: 'text', text: 'hi' }])
    expect(out.messages[1]?.role).toBe('assistant')
    expect(out.messages[1]?.parts).toEqual([{ kind: 'text', text: 'hello' }])
  })

  test('walks active path from latest-timestamp leaf when branches exist', () => {
    // u1 → a1 (older), u1 → a2 (newer). Active leaf = a2.
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'hi', '2026-05-17T09:15:00.000Z'),
        assistantText('a1', 'u1', 'old branch', '2026-05-17T09:15:01.000Z'),
        assistantText('a2', 'u1', 'new branch', '2026-05-17T09:16:00.000Z'),
      ),
    )
    expect(out.messages).toHaveLength(2)
    expect(out.messages[1]?.parts).toEqual([
      { kind: 'text', text: 'new branch' },
    ])
  })

  test('toolCall content parts produce ToolPart on the assistant message', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'do it'),
        toolCallMsg('a1', 'u1', 'tc1', 'read', { path: '/x' }),
      ),
    )
    const tool = firstToolPart(out.messages[1]?.parts)
    expect(tool.name).toBe('read')
    expect(tool.id).toBe('tc1')
    expect(tool.input).toEqual({ path: '/x' })
  })

  test('toolResult attaches result to matching pending toolCall by toolCallId', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'do it'),
        toolCallMsg('a1', 'u1', 'tc1', 'read', { path: '/x' }),
        toolResultMsg('r1', 'a1', 'tc1', 'read', 'file contents'),
      ),
    )
    const tool = firstToolPart(out.messages[1]?.parts)
    expect(tool.result).toEqual({ content: 'file contents', isError: false })
  })

  test('bashExecution role becomes a user message with a bashExecution tool part', () => {
    const out = normalize(
      jsonl(sessionHeader, bashExec('b1', null, 'ls', 'file1\nfile2\n')),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.name).toBe('bashExecution')
    expect(tool.input.command).toBe('ls')
    expect(tool.result).toEqual({
      content: 'file1\nfile2\n',
      isError: false,
    })
  })

  test('bashExecution with non-zero exitCode marks the result as error', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        bashExec('b1', null, 'll', 'command not found\n', { exitCode: 127 }),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.result?.isError).toBe(true)
  })

  test('bashExecution.excludeFromContext propagates to the tool input', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        bashExec('b1', null, 'echo', '', { excludeFromContext: true }),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.input.excludeFromContext).toBe(true)
  })

  test('bashExecution name is distinct from an LLM-issued bash tool call', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        bashExec('b1', null, 'ls', 'a\n'),
        toolCallMsg('a1', 'b1', 'tc1', 'bash', { command: 'ls' }),
      ),
    )
    expect(out.messages).toHaveLength(2)
    const userTool = firstToolPart(out.messages[0]?.parts)
    const assistantTool = firstToolPart(out.messages[1]?.parts)
    expect(userTool.name).toBe('bashExecution')
    expect(assistantTool.name).toBe('bash')
  })

  test('bare type:"custom" entries are skipped entirely', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        {
          type: 'custom',
          customType: 'scheduler-task',
          data: {},
          id: 'c1',
          parentId: null,
          timestamp: '2026-05-17T09:15:00.000Z',
        },
        userMsg('u1', 'c1', 'after-custom'),
      ),
    )
    // Active path includes u1 but the custom entry is not emitted.
    expect(out.messages.find((m) => m.role === 'assistant')).toBeUndefined()
    // Even though u1's parent is the skipped custom, the user message is kept.
    const userParts = out.messages.find((m) => m.role === 'user')?.parts
    expect(userParts).toEqual([{ kind: 'text', text: 'after-custom' }])
  })

  test('custom_message routes through a generic tool fallback (user-role)', () => {
    const out = normalize(
      jsonl(sessionHeader, {
        type: 'custom_message',
        customType: 'pi-splash',
        content: 'splash text',
        display: true,
        id: 'cm1',
        parentId: null,
        timestamp: '2026-05-17T09:14:00.000Z',
      }),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.name).toBe('pi-splash')
  })

  test('toolResult.details is forwarded to the pending tool result', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'edit it'),
        toolCallMsg('a1', 'u1', 'tc1', 'edit', { path: '/foo.ts' }),
        {
          type: 'message',
          id: 'r1',
          parentId: 'a1',
          timestamp: '2026-05-17T09:15:31.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'tc1',
            toolName: 'edit',
            content: [{ type: 'text', text: 'ok' }],
            details: { diff: '-old\n+new' },
          },
        },
      ),
    )
    const tool = firstToolPart(out.messages[1]?.parts)
    expect(tool.result?.details).toEqual({ diff: '-old\n+new' })
  })

  test('model_change and thinking_level_change on active path are dropped from messages', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        {
          type: 'thinking_level_change',
          id: 't1',
          parentId: null,
          timestamp: '2026-05-17T09:14:00.000Z',
          thinkingLevel: 'medium',
        },
        {
          type: 'model_change',
          id: 'm1',
          parentId: 't1',
          timestamp: '2026-05-17T09:14:01.000Z',
          provider: 'github-copilot',
          modelId: 'gpt-5',
        },
        userMsg('u1', 'm1', 'hi'),
      ),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
  })
})

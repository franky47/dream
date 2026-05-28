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

  test('compaction on active path drops history before firstKeptEntryId and emits a summary block', () => {
    const compaction = {
      type: 'compaction',
      id: 'cmp1',
      parentId: 'a1',
      timestamp: '2026-05-17T09:20:00.000Z',
      firstKeptEntryId: 'u2',
      summary: 'pre-cutoff summary',
      tokensBefore: 12345,
    }
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'pre-1', '2026-05-17T09:15:00.000Z'),
        assistantText('a1', 'u1', 'pre-2', '2026-05-17T09:15:01.000Z'),
        compaction,
        userMsg('u2', 'cmp1', 'after-cutoff', '2026-05-17T09:25:00.000Z'),
        assistantText('a2', 'u2', 'kept reply', '2026-05-17T09:25:01.000Z'),
      ),
    )

    expect(out.messages).toHaveLength(3)
    const first = out.messages[0]
    expect(first?.role).toBe('user')
    const firstText = first?.parts[0]
    expect(firstText?.kind).toBe('text')
    if (firstText?.kind === 'text') {
      expect(firstText.text).toContain('<compaction tokensBefore="12345">')
      expect(firstText.text).toContain('pre-cutoff summary')
      expect(firstText.text).toContain('</compaction>')
    }
    expect(out.messages[1]?.parts).toEqual([
      { kind: 'text', text: 'after-cutoff' },
    ])
    expect(out.messages[2]?.parts).toEqual([
      { kind: 'text', text: 'kept reply' },
    ])
  })

  test('no compaction → output matches the baseline (no synthetic summary block)', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'hi'),
        assistantText('a1', 'u1', 'hello'),
      ),
    )
    expect(out.messages).toHaveLength(2)
    for (const msg of out.messages) {
      for (const part of msg.parts) {
        if (part.kind === 'text') {
          expect(part.text).not.toContain('<compaction')
        }
      }
    }
  })

  test('compaction off the active path has no effect', () => {
    // Active leaf is a2 (later than cmp1); a1's branch (with compaction
    // as a dead leaf) is not walked.
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'hi', '2026-05-17T09:15:00.000Z'),
        assistantText('a1', 'u1', 'old branch', '2026-05-17T09:15:01.000Z'),
        {
          type: 'compaction',
          id: 'cmp1',
          parentId: 'a1',
          timestamp: '2026-05-17T09:15:30.000Z',
          firstKeptEntryId: 'u1',
          summary: 'should not appear',
        },
        assistantText('a2', 'u1', 'new branch', '2026-05-17T09:18:00.000Z'),
      ),
    )
    for (const msg of out.messages) {
      for (const part of msg.parts) {
        if (part.kind === 'text') {
          expect(part.text).not.toContain('should not appear')
          expect(part.text).not.toContain('<compaction')
        }
      }
    }
  })

  test('multiple compactions on the same path: latest wins for the earliest cutoff', () => {
    // path: u1 → a1 → cmpA → u2 → a2 → cmpB → u3 → a3
    // cmpA points to u2 (cuts u1+a1), cmpB points to u3 (cuts u1+a1+u2+a2 and cmpA).
    // Expect: only the cmpB summary is emitted; u3 + a3 follow.
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'pre-1', '2026-05-17T09:15:00.000Z'),
        assistantText('a1', 'u1', 'pre-2', '2026-05-17T09:15:01.000Z'),
        {
          type: 'compaction',
          id: 'cmpA',
          parentId: 'a1',
          timestamp: '2026-05-17T09:16:00.000Z',
          firstKeptEntryId: 'u2',
          summary: 'older summary',
        },
        userMsg('u2', 'cmpA', 'mid-1', '2026-05-17T09:17:00.000Z'),
        assistantText('a2', 'u2', 'mid-2', '2026-05-17T09:17:01.000Z'),
        {
          type: 'compaction',
          id: 'cmpB',
          parentId: 'a2',
          timestamp: '2026-05-17T09:18:00.000Z',
          firstKeptEntryId: 'u3',
          summary: 'newer summary',
        },
        userMsg('u3', 'cmpB', 'post-1', '2026-05-17T09:19:00.000Z'),
        assistantText('a3', 'u3', 'post-2', '2026-05-17T09:19:01.000Z'),
      ),
    )

    expect(out.messages).toHaveLength(3)
    const first = out.messages[0]?.parts[0]
    expect(first?.kind).toBe('text')
    if (first?.kind === 'text') {
      expect(first.text).toContain('newer summary')
      expect(first.text).not.toContain('older summary')
    }
    expect(out.messages[1]?.parts).toEqual([{ kind: 'text', text: 'post-1' }])
    expect(out.messages[2]?.parts).toEqual([{ kind: 'text', text: 'post-2' }])
  })

  test('compaction without tokensBefore renders summary without the attribute', () => {
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'pre', '2026-05-17T09:15:00.000Z'),
        {
          type: 'compaction',
          id: 'cmp',
          parentId: 'u1',
          timestamp: '2026-05-17T09:16:00.000Z',
          firstKeptEntryId: 'u2',
          summary: 'just a summary',
        },
        userMsg('u2', 'cmp', 'kept', '2026-05-17T09:17:00.000Z'),
      ),
    )
    const first = out.messages[0]?.parts[0]
    expect(first?.kind).toBe('text')
    if (first?.kind === 'text') {
      expect(first.text).toBe('<compaction>\njust a summary\n</compaction>')
    }
  })

  test('compaction whose firstKeptEntryId is not on the active path is ignored', () => {
    // firstKeptEntryId references a node that doesn't exist on this path.
    const out = normalize(
      jsonl(
        sessionHeader,
        userMsg('u1', null, 'first', '2026-05-17T09:15:00.000Z'),
        {
          type: 'compaction',
          id: 'cmp',
          parentId: 'u1',
          timestamp: '2026-05-17T09:16:00.000Z',
          firstKeptEntryId: 'nonexistent',
          summary: 'orphan',
        },
        assistantText('a1', 'cmp', 'reply', '2026-05-17T09:17:00.000Z'),
      ),
    )
    for (const msg of out.messages) {
      for (const part of msg.parts) {
        if (part.kind === 'text') {
          expect(part.text).not.toContain('orphan')
          expect(part.text).not.toContain('<compaction')
        }
      }
    }
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

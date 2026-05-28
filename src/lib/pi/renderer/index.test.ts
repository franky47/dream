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
  test('renders frontmatter + turn markers + text + bespoke read end-to-end', () => {
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
    expect(out).toContain('<tool name="read" path="/x">')
    expect(out).toContain('file body')
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

  test('bespoke bash/read/edit/write renderers fire end-to-end on a multi-tool session', () => {
    const input = jsonl(
      sessionHeader,
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-17T09:15:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'work' }] },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-17T09:15:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc1',
              name: 'bash',
              arguments: { command: 'ls' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'r1',
        parentId: 'a1',
        timestamp: '2026-05-17T09:15:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tc1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'a\nb' }],
        },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'r1',
        timestamp: '2026-05-17T09:15:03.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc2',
              name: 'read',
              arguments: { path: '/foo.ts' },
            },
            {
              type: 'toolCall',
              id: 'tc3',
              name: 'edit',
              arguments: { path: '/foo.ts' },
            },
            {
              type: 'toolCall',
              id: 'tc4',
              name: 'write',
              arguments: { path: '/new.ts', content: 'hi\n' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'r2',
        parentId: 'a2',
        timestamp: '2026-05-17T09:15:04.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tc2',
          toolName: 'read',
          content: [{ type: 'text', text: 'file body' }],
        },
      },
      {
        type: 'message',
        id: 'r3',
        parentId: 'r2',
        timestamp: '2026-05-17T09:15:05.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tc3',
          toolName: 'edit',
          content: [{ type: 'text', text: 'ok' }],
          details: { diff: '-old\n+new' },
        },
      },
    )

    const out = renderPiSession(input)

    expect(out).toContain('<tool name="bash" command="ls">')
    expect(out).toContain('<tool name="read" path="/foo.ts">')
    expect(out).toContain('<tool name="edit" path="/foo.ts">')
    expect(out).toContain('-old')
    expect(out).toContain('+new')
    expect(out).toContain(
      '<tool name="write" path="/new.ts" lines="1" bytes="3"/>',
    )
  })

  test('compaction on active path renders summary block in place of pre-cutoff history (real-shape fixture)', () => {
    // Fixture shape mirrors a real Pi session with one compaction event;
    // ids/text/paths are synthetic.
    const input = jsonl(
      sessionHeader,
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-17T09:14:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'pre-cutoff question' }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-17T09:14:30.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'pre-cutoff answer' }],
        },
      },
      {
        type: 'compaction',
        id: 'cmp',
        parentId: 'a1',
        timestamp: '2026-05-17T09:20:00.000Z',
        firstKeptEntryId: 'u2',
        summary: 'condensed pre-cutoff conversation',
        tokensBefore: 8421,
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'cmp',
        timestamp: '2026-05-17T09:21:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'kept follow-up' }],
        },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'u2',
        timestamp: '2026-05-17T09:21:30.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'kept reply' }],
        },
      },
    )

    const out = renderPiSession(input)

    expect(out).toContain('<compaction tokensBefore="8421">')
    expect(out).toContain('condensed pre-cutoff conversation')
    expect(out).toContain('</compaction>')
    expect(out).not.toContain('pre-cutoff question')
    expect(out).not.toContain('pre-cutoff answer')
    expect(out).toContain('kept follow-up')
    expect(out).toContain('kept reply')
    expect(out).toContain('sessionId: ses_1')
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

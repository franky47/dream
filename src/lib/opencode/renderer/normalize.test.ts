import { describe, expect, test } from 'bun:test'

import type { Part, ToolPart } from '#lib/renderer/types'

import { normalize } from './normalize.ts'

function firstToolPart(parts: ReadonlyArray<Part> | undefined): ToolPart {
  const p = parts?.[0]
  if (p === undefined || p.kind !== 'tool') {
    throw new Error(
      `expected first part to be a tool, got ${p?.kind ?? 'none'}`,
    )
  }
  return p
}

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const session = {
  type: 'session',
  id: 'ses_1',
  sessionId: 'ses_1',
  title: 'A session',
  directory: '/repo/dream',
  project: { id: 'p', worktree: '/repo', vcs: 'git', name: 'dream' },
}

function msg(extra: Record<string, unknown>): unknown {
  return {
    type: 'message',
    id: 'msg_x',
    sessionId: 'ses_1',
    role: 'user',
    time: { created: 1_000 },
    ...extra,
  }
}

function part(extra: Record<string, unknown>): unknown {
  return {
    type: 'part',
    id: 'prt_x',
    sessionId: 'ses_1',
    messageId: 'msg_x',
    ...extra,
  }
}

describe('normalize', () => {
  test('produces NormalizedSession with frontmatterYaml and ordered messages', () => {
    const out = normalize(
      jsonl(
        session,
        msg({
          id: 'm1',
          role: 'user',
          time: { created: Date.parse('2026-05-11T10:00:00Z') },
        }),
        part({
          id: 'p1',
          messageId: 'm1',
          partType: 'text',
          text: 'hello',
        }),
        msg({
          id: 'm2',
          role: 'assistant',
          time: { created: Date.parse('2026-05-11T10:00:05Z') },
        }),
        part({
          id: 'p2',
          messageId: 'm2',
          partType: 'text',
          text: 'world',
        }),
      ),
    )
    expect(out.frontmatterYaml).toContain('sessionId: ses_1')
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0]?.role).toBe('user')
    expect(out.messages[0]?.timestampMs).toBe(
      Date.parse('2026-05-11T10:00:00Z'),
    )
    expect(out.messages[0]?.parts).toEqual([{ kind: 'text', text: 'hello' }])
    expect(out.messages[1]?.role).toBe('assistant')
  })

  test('groups parts by messageId regardless of arrival interleaving', () => {
    const out = normalize(
      jsonl(
        session,
        msg({
          id: 'm1',
          role: 'assistant',
          time: { created: 1_000 },
        }),
        part({ id: 'p1', messageId: 'm1', partType: 'text', text: 'a' }),
        // out-of-order: a part for m1 appears after m2
        msg({
          id: 'm2',
          role: 'user',
          time: { created: 2_000 },
        }),
        part({ id: 'p2', messageId: 'm1', partType: 'text', text: 'b' }),
      ),
    )
    expect(out.messages[0]?.parts).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ])
  })

  test('drops reasoning/step-start/step-finish/patch/file/agent/subtask/compaction parts', () => {
    const out = normalize(
      jsonl(
        session,
        msg({ id: 'm1', role: 'assistant', time: { created: 1_000 } }),
        part({ id: 'p1', messageId: 'm1', partType: 'reasoning', text: '...' }),
        part({ id: 'p2', messageId: 'm1', partType: 'step-start' }),
        part({ id: 'p3', messageId: 'm1', partType: 'step-finish' }),
        part({ id: 'p4', messageId: 'm1', partType: 'patch' }),
        part({ id: 'p5', messageId: 'm1', partType: 'file' }),
        part({ id: 'p6', messageId: 'm1', partType: 'agent' }),
        part({ id: 'p7', messageId: 'm1', partType: 'subtask' }),
        part({ id: 'p8', messageId: 'm1', partType: 'compaction' }),
        part({ id: 'p9', messageId: 'm1', partType: 'text', text: 'kept' }),
      ),
    )
    expect(out.messages[0]?.parts).toEqual([{ kind: 'text', text: 'kept' }])
  })

  test('tool part with status=completed gets result.isError=false and string output', () => {
    const out = normalize(
      jsonl(
        session,
        msg({ id: 'm1', role: 'assistant', time: { created: 1_000 } }),
        part({
          id: 'p1',
          messageId: 'm1',
          partType: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'a\nb',
          },
        }),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.kind).toBe('tool')
    expect(tool.id).toBe('c1')
    expect(tool.name).toBe('bash')
    expect(tool.input).toEqual({ command: 'ls' })
    expect(tool.result).toEqual({ content: 'a\nb', isError: false })
  })

  test('tool part with status=error gets result.isError=true, content from state.error fallback', () => {
    const out = normalize(
      jsonl(
        session,
        msg({ id: 'm1', role: 'assistant', time: { created: 1_000 } }),
        part({
          id: 'p1',
          messageId: 'm1',
          partType: 'tool',
          tool: 'apply_patch',
          callID: 'c1',
          state: {
            status: 'error',
            input: {},
            error: 'aborted',
          },
        }),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.result).toEqual({ content: 'aborted', isError: true })
  })

  test('tool part with running/pending status has result undefined', () => {
    const out = normalize(
      jsonl(
        session,
        msg({ id: 'm1', role: 'assistant', time: { created: 1_000 } }),
        part({
          id: 'p1',
          messageId: 'm1',
          partType: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'pending', input: {} },
        }),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.result).toBeUndefined()
  })

  test('non-string state.output is coerced via JSON.stringify', () => {
    const out = normalize(
      jsonl(
        session,
        msg({ id: 'm1', role: 'assistant', time: { created: 1_000 } }),
        part({
          id: 'p1',
          messageId: 'm1',
          partType: 'tool',
          tool: 'read',
          callID: 'c1',
          state: {
            status: 'completed',
            input: {},
            output: { lines: ['a', 'b'], n: 2 },
          },
        }),
      ),
    )
    const tool = firstToolPart(out.messages[0]?.parts)
    expect(tool.result?.content).toBe('{"lines":["a","b"],"n":2}')
  })

  test('messages with no qualifying parts emit empty parts (bare turn marker downstream)', () => {
    const out = normalize(
      jsonl(
        session,
        msg({ id: 'm1', role: 'user', time: { created: 1_000 } }),
        part({ id: 'p1', messageId: 'm1', partType: 'reasoning', text: 'x' }),
      ),
    )
    expect(out.messages[0]?.parts).toEqual([])
  })
})

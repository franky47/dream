import { describe, expect, test } from 'bun:test'

import { renderCodexSession } from './index.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const meta = {
  timestamp: '2026-05-22T18:43:47.456Z',
  type: 'session_meta',
  payload: {
    id: 'ses_1',
    timestamp: '2026-05-22T18:43:24.364Z',
    cwd: '/repo/dream',
    originator: 'Codex Desktop',
    cli_version: '0.133.0',
    model_provider: 'openai',
    git: null,
  },
}

describe('renderCodexSession', () => {
  test('renders frontmatter, turn markers, text, and tool fallback end-to-end', () => {
    const input = jsonl(
      meta,
      {
        timestamp: '2026-05-22T18:44:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'list files' }],
        },
      },
      {
        timestamp: '2026-05-22T18:44:30.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'c1',
          arguments: '{"cmd":"ls"}',
        },
      },
      {
        timestamp: '2026-05-22T18:44:31.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'a\nb',
        },
      },
    )

    const out = renderCodexSession(input)

    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('sessionId: ses_1')
    expect(out).toContain('renderer: "codex-md@1"')
    expect(out).toContain('<turn n="1" role="user" t="0"/>')
    expect(out).toContain('list files')
    expect(out).toContain('<turn n="2" role="assistant" t="+0m30s"/>')
    expect(out).toContain('<tool name="exec_command" cmd="ls"/>')
    expect(out.endsWith('\n')).toBe(true)
  })

  test('renders exec_command + apply_patch via bespoke renderers end-to-end', () => {
    const execOutput = [
      'Chunk ID: ck1',
      'Wall time: 0.123s',
      'Process exited with code: 0',
      'Original token count: 5',
      'Output:',
      '---',
      'README.md',
      'package.json',
    ].join('\n')
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/foo.ts',
      '@@ function bar()',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')
    const input = jsonl(
      meta,
      {
        timestamp: '2026-05-22T18:44:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'c1',
          arguments: '{"cmd":"ls"}',
        },
      },
      {
        timestamp: '2026-05-22T18:44:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: execOutput,
        },
      },
      {
        timestamp: '2026-05-22T18:44:02.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'p1',
          input: patch,
        },
      },
      {
        timestamp: '2026-05-22T18:44:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'p1',
          output: 'Exit code: 0\nSuccess. Updated:\nM src/foo.ts',
        },
      },
    )

    const out = renderCodexSession(input)

    expect(out).toContain(
      '<tool name="exec_command" cmd="ls" exit="0" wall="0.123s">',
    )
    expect(out).toContain('README.md')
    expect(out).toContain('package.json')
    expect(out).toContain('<tool name="apply_patch" exit="0">')
    expect(out).toContain('--- a/src/foo.ts')
    expect(out).toContain('+++ b/src/foo.ts')
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })

  test('drops noisy events end-to-end (agent_message, token_count, lifecycle)', () => {
    const input = jsonl(
      meta,
      {
        timestamp: '2026-05-22T18:44:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started' },
      },
      {
        timestamp: '2026-05-22T18:44:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        },
      },
      {
        timestamp: '2026-05-22T18:44:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'duplicate',
          phase: 'commentary',
        },
      },
      {
        timestamp: '2026-05-22T18:44:03.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: {} },
      },
    )

    const out = renderCodexSession(input)
    expect(out).toContain('<turn n="1" role="user"')
    expect(out).not.toContain('duplicate')
    expect(out).not.toContain('token_count')
    expect(out).not.toContain('task_started')
  })
})

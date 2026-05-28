import { describe, expect, test } from 'bun:test'

import { renderSession } from './render.ts'
import type { NormalizedSession, RenderConfig } from './types.ts'

const noopConfig: RenderConfig<undefined> = {
  preprocess: () => undefined,
  tools: {},
  fallback: () => '',
}

function session(
  messages: NormalizedSession['messages'],
  frontmatterYaml = '---\nx: 1\n---\n',
): NormalizedSession {
  return { frontmatterYaml, messages }
}

describe('renderSession', () => {
  test('single message emits turn marker with t="0"', () => {
    const out = renderSession(
      session([
        {
          role: 'user',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [{ kind: 'text', text: 'hello' }],
        },
      ]),
      noopConfig,
    )
    expect(out).toContain('<turn n="1" role="user" t="0"/>')
    expect(out).toContain('hello')
  })

  test('subsequent timestamps render as +MMmSSs deltas from first', () => {
    const out = renderSession(
      session([
        {
          role: 'user',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [{ kind: 'text', text: 'q' }],
        },
        {
          role: 'assistant',
          timestampMs: Date.parse('2026-05-11T10:04:12Z'),
          parts: [{ kind: 'text', text: 'a' }],
        },
      ]),
      noopConfig,
    )
    expect(out).toContain('<turn n="1" role="user" t="0"/>')
    expect(out).toContain('<turn n="2" role="assistant" t="+4m12s"/>')
  })

  test('null timestampMs omits t attribute', () => {
    const out = renderSession(
      session([
        {
          role: 'user',
          timestampMs: null,
          parts: [{ kind: 'text', text: 'q' }],
        },
      ]),
      noopConfig,
    )
    expect(out).toContain('<turn n="1" role="user"/>')
  })

  test('empty parts emits bare turn marker (no body line)', () => {
    const out = renderSession(
      session([
        {
          role: 'user',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [],
        },
      ]),
      noopConfig,
    )
    expect(out).toContain('<turn n="1" role="user" t="0"/>')
    expect(out.endsWith('<turn n="1" role="user" t="0"/>\n')).toBe(true)
  })

  test('emits frontmatter + blank line + body + trailing newline', () => {
    const out = renderSession(
      session([
        {
          role: 'user',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [{ kind: 'text', text: 'hello' }],
        },
      ]),
      noopConfig,
    )
    expect(out.startsWith('---\nx: 1\n---\n\n')).toBe(true)
    expect(out.endsWith('\n')).toBe(true)
  })

  test('tool parts dispatch via registry by name', () => {
    const config: RenderConfig<undefined> = {
      preprocess: () => undefined,
      tools: {
        Bash: (tool) =>
          `<tool name="Bash" cmd="${String(tool.input.command)}"/>`,
      },
      fallback: () => '<unknown/>',
    }
    const out = renderSession(
      session([
        {
          role: 'assistant',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [
            {
              kind: 'tool',
              id: 't1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      ]),
      config,
    )
    expect(out).toContain('<tool name="Bash" cmd="ls"/>')
    expect(out).not.toContain('<unknown/>')
  })

  test('unknown tool name routes to fallback', () => {
    const config: RenderConfig<undefined> = {
      preprocess: () => undefined,
      tools: {},
      fallback: (tool) => `<fb name="${tool.name}"/>`,
    }
    const out = renderSession(
      session([
        {
          role: 'assistant',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [{ kind: 'tool', id: 'x', name: 'Mystery', input: {} }],
        },
      ]),
      config,
    )
    expect(out).toContain('<fb name="Mystery"/>')
  })

  test('renderer returning empty string skips the part entirely', () => {
    const config: RenderConfig<undefined> = {
      preprocess: () => undefined,
      tools: { Skip: () => '' },
      fallback: () => 'X',
    }
    const out = renderSession(
      session([
        {
          role: 'assistant',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [
            { kind: 'tool', id: 's', name: 'Skip', input: {} },
            { kind: 'text', text: 'after' },
          ],
        },
      ]),
      config,
    )
    expect(out).toContain('after')
    // Body line should be just "after", with no blank line from the skipped tool.
    const lines = out.split('\n')
    const turnIdx = lines.findIndex((l) => l.startsWith('<turn'))
    expect(lines[turnIdx + 1]).toBe('after')
  })

  test('state is produced by preprocess and threaded into tool renderers', () => {
    interface S {
      seen: string[]
    }
    const config: RenderConfig<S> = {
      preprocess: (msgs) => ({ seen: [`msgs=${msgs.length}`] }),
      tools: {
        Push: (tool, { state }) => {
          state.seen.push(String(tool.input.tag))
          return `<seen>${state.seen.join(',')}</seen>`
        },
      },
      fallback: () => '',
    }
    const out = renderSession(
      session([
        {
          role: 'assistant',
          timestampMs: Date.parse('2026-05-11T10:00:00Z'),
          parts: [
            { kind: 'tool', id: '1', name: 'Push', input: { tag: 'a' } },
            { kind: 'tool', id: '2', name: 'Push', input: { tag: 'b' } },
          ],
        },
      ]),
      config,
    )
    expect(out).toContain('<seen>msgs=1,a</seen>')
    expect(out).toContain('<seen>msgs=1,a,b</seen>')
  })
})

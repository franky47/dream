import { describe, expect, test } from 'bun:test'

import type { ToolPart } from '#lib/renderer/types'

import { hermesFallback, hermesTools } from './tools.ts'

function tool(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: 'tool',
    id: 'tc1',
    name: 'terminal',
    input: {},
    ...overrides,
  }
}

function callTool(name: string, t: ToolPart): string {
  const renderer = hermesTools[name]
  if (renderer === undefined) throw new Error(`no renderer for ${name}`)
  return renderer(t, { state: undefined })
}

function lines(...rows: string[]): string {
  return rows.join('\n')
}

describe('hermesTools registry', () => {
  test('registers only the verified Hermes tool shapes', () => {
    expect(Object.keys(hermesTools).sort()).toEqual(['skill_view', 'terminal'])
  })
})

describe('hermesFallback', () => {
  test('emits a self-closing tag with the tool name', () => {
    expect(
      hermesFallback(tool({ name: 'browser' }), { state: undefined }),
    ).toBe('<tool name="browser"/>')
  })

  test('projects scalar inputs as attributes', () => {
    expect(
      hermesFallback(
        tool({ name: 'browser', input: { url: 'x', tab: 2, active: true } }),
        { state: undefined },
      ),
    ).toBe('<tool name="browser" url="x" tab="2" active="true"/>')
  })

  test('drops non-scalar inputs', () => {
    expect(
      hermesFallback(
        tool({ name: 'browser', input: { nested: { k: 1 }, ok: 'yes' } }),
        { state: undefined },
      ),
    ).toBe('<tool name="browser" ok="yes"/>')
  })

  test('escapes special chars in name and values', () => {
    expect(
      hermesFallback(tool({ name: 'a<b&c', input: { x: 'l1\nl2\t"q"' } }), {
        state: undefined,
      }),
    ).toBe('<tool name="a&lt;b&amp;c" x="l1&#10;l2&#9;&quot;q&quot;"/>')
  })

  test('marks failed unknown tools with error="1"', () => {
    expect(
      hermesFallback(
        tool({
          name: 'browser',
          input: { url: 'x' },
          result: { content: 'boom', isError: true },
        }),
        { state: undefined },
      ),
    ).toBe('<tool name="browser" url="x" error="1"/>')
  })
})

describe('terminal renderer', () => {
  test('renders command and output body', () => {
    expect(
      callTool(
        'terminal',
        tool({
          name: 'terminal',
          input: { command: 'ls' },
          result: { content: 'a\nb', isError: false },
        }),
      ),
    ).toBe(lines('<tool name="terminal" command="ls">', 'a', 'b', '</tool>'))
  })

  test('renders the workdir when present', () => {
    expect(
      callTool(
        'terminal',
        tool({
          name: 'terminal',
          input: { command: 'ls', workdir: '/src' },
          result: { content: 'out', isError: false },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="terminal" command="ls" workdir="/src">',
        'out',
        '</tool>',
      ),
    )
  })

  test('self-closing when the result is missing', () => {
    expect(
      callTool(
        'terminal',
        tool({ name: 'terminal', input: { command: 'ls' } }),
      ),
    ).toBe('<tool name="terminal" command="ls"/>')
  })

  test('marks a failed terminal call with error="1"', () => {
    expect(
      callTool(
        'terminal',
        tool({
          name: 'terminal',
          input: { command: 'boom' },
          result: { content: 'stderr', isError: true },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="terminal" command="boom" error="1">',
        'stderr',
        '</tool>',
      ),
    )
  })

  test('escapes the command attribute', () => {
    expect(
      callTool(
        'terminal',
        tool({ name: 'terminal', input: { command: 'echo "a"&<b>' } }),
      ),
    ).toBe('<tool name="terminal" command="echo &quot;a&quot;&amp;&lt;b&gt;"/>')
  })
})

describe('skill_view renderer', () => {
  test('shows which skill and file were viewed, self-closing', () => {
    expect(
      callTool(
        'skill_view',
        tool({
          name: 'skill_view',
          input: { name: 'hermes-agent', file_path: 'references/webhooks.md' },
          result: { content: 'huge skill body', isError: false },
        }),
      ),
    ).toBe(
      '<tool name="skill_view" skill="hermes-agent" file="references/webhooks.md"/>',
    )
  })

  test('omits the file attribute when only the skill name is present', () => {
    expect(
      callTool(
        'skill_view',
        tool({ name: 'skill_view', input: { name: 'hermes-agent' } }),
      ),
    ).toBe('<tool name="skill_view" skill="hermes-agent"/>')
  })

  test('marks a failed skill_view with error="1"', () => {
    expect(
      callTool(
        'skill_view',
        tool({
          name: 'skill_view',
          input: { name: 'missing' },
          result: { content: 'not found', isError: true },
        }),
      ),
    ).toBe('<tool name="skill_view" skill="missing" error="1"/>')
  })
})

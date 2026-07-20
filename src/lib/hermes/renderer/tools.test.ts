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
  test('registers every supported Hermes tool shape', () => {
    expect(Object.keys(hermesTools).sort()).toEqual([
      'clarify',
      'patch',
      'read',
      'search',
      'terminal',
      'todo',
      'write',
    ])
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

  test('retains exit and status from the result envelope', () => {
    expect(
      callTool(
        'terminal',
        tool({
          name: 'terminal',
          input: { command: 'false' },
          result: {
            content: 'out',
            isError: false,
            details: { exitCode: 1, status: 'timeout' },
          },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="terminal" command="false" exit="1" status="timeout">',
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

  test('ignores a malformed status envelope', () => {
    expect(
      callTool(
        'terminal',
        tool({
          name: 'terminal',
          input: { command: 'ls' },
          result: { content: 'x', isError: false, details: 'nope' },
        }),
      ),
    ).toBe(lines('<tool name="terminal" command="ls">', 'x', '</tool>'))
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

describe('read renderer', () => {
  test('renders path with file content', () => {
    expect(
      callTool(
        'read',
        tool({
          name: 'read',
          input: { path: '/etc/hosts' },
          result: { content: 'l1\nl2', isError: false },
        }),
      ),
    ).toBe(lines('<tool name="read" path="/etc/hosts">', 'l1', 'l2', '</tool>'))
  })

  test('renders offset and limit when present', () => {
    expect(
      callTool(
        'read',
        tool({
          name: 'read',
          input: { path: '/big', offset: 10, limit: 5 },
          result: { content: 'chunk', isError: false },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="read" path="/big" offset="10" limit="5">',
        'chunk',
        '</tool>',
      ),
    )
  })

  test('self-closing when content is empty', () => {
    expect(
      callTool(
        'read',
        tool({
          name: 'read',
          input: { path: '/x' },
          result: { content: '', isError: false },
        }),
      ),
    ).toBe('<tool name="read" path="/x"/>')
  })

  test('marks a failed read with error="1"', () => {
    expect(
      callTool(
        'read',
        tool({
          name: 'read',
          input: { path: '/missing' },
          result: { content: 'no such file', isError: true },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="read" path="/missing" error="1">',
        'no such file',
        '</tool>',
      ),
    )
  })
})

describe('write renderer', () => {
  test('summarizes with lines and bytes instead of copying content', () => {
    expect(
      callTool(
        'write',
        tool({
          name: 'write',
          input: { path: '/new.ts', content: 'a\nb\nc\n' },
        }),
      ),
    ).toBe('<tool name="write" path="/new.ts" lines="3" bytes="6"/>')
  })

  test('handles missing content as zero stats', () => {
    expect(
      callTool('write', tool({ name: 'write', input: { path: '/empty.ts' } })),
    ).toBe('<tool name="write" path="/empty.ts" lines="0" bytes="0"/>')
  })

  test('counts utf-8 bytes', () => {
    expect(
      callTool(
        'write',
        tool({ name: 'write', input: { path: '/u.txt', content: '€' } }),
      ),
    ).toBe('<tool name="write" path="/u.txt" lines="1" bytes="3"/>')
  })

  test('keeps a success write self-closing', () => {
    expect(
      callTool(
        'write',
        tool({
          name: 'write',
          input: { path: '/ok.ts', content: 'x' },
          result: { content: 'wrote 1 byte', isError: false },
        }),
      ),
    ).toBe('<tool name="write" path="/ok.ts" lines="1" bytes="1"/>')
  })

  test('shows the error body on a failed write', () => {
    expect(
      callTool(
        'write',
        tool({
          name: 'write',
          input: { path: '/ro.ts', content: 'x' },
          result: { content: 'permission denied', isError: true },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="write" path="/ro.ts" lines="1" bytes="1" error="1">',
        'permission denied',
        '</tool>',
      ),
    )
  })
})

describe('patch renderer', () => {
  test('renders the diff body with path and exit', () => {
    expect(
      callTool(
        'patch',
        tool({
          name: 'patch',
          input: { path: '/foo.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
          result: { content: 'ok', isError: false, details: { exitCode: 0 } },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="patch" path="/foo.ts" exit="0">',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '</tool>',
      ),
    )
  })

  test('falls back to the patch field when diff is absent', () => {
    expect(
      callTool('patch', tool({ name: 'patch', input: { patch: '-a\n+b' } })),
    ).toBe(lines('<tool name="patch">', '-a', '+b', '</tool>'))
  })

  test('self-closing when there is no diff', () => {
    expect(
      callTool('patch', tool({ name: 'patch', input: { path: '/foo.ts' } })),
    ).toBe('<tool name="patch" path="/foo.ts"/>')
  })

  test('marks a failed patch with error="1"', () => {
    expect(
      callTool(
        'patch',
        tool({
          name: 'patch',
          input: { path: '/foo.ts', diff: '-a\n+b' },
          result: { content: 'conflict', isError: true },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="patch" path="/foo.ts" error="1">',
        '-a',
        '+b',
        '</tool>',
      ),
    )
  })
})

describe('search renderer', () => {
  test('renders query, path and match body', () => {
    expect(
      callTool(
        'search',
        tool({
          name: 'search',
          input: { query: 'TODO', path: '/src' },
          result: { content: 'a.ts:1\nb.ts:2', isError: false },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="search" query="TODO" path="/src">',
        'a.ts:1',
        'b.ts:2',
        '</tool>',
      ),
    )
  })

  test('omits path when absent and self-closes on no matches', () => {
    expect(
      callTool(
        'search',
        tool({
          name: 'search',
          input: { query: 'zzz' },
          result: { content: '', isError: false },
        }),
      ),
    ).toBe('<tool name="search" query="zzz"/>')
  })
})

describe('todo renderer', () => {
  test('renders a checklist with completed and pending marks', () => {
    expect(
      callTool(
        'todo',
        tool({
          name: 'todo',
          input: {
            todos: [
              { content: 'first', status: 'completed' },
              { content: 'second', status: 'pending' },
              { content: 'third' },
            ],
          },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="todo">',
        '- [x] first',
        '- [ ] second',
        '- [ ] third',
        '</tool>',
      ),
    )
  })

  test('self-closing on a malformed todo list', () => {
    expect(
      callTool('todo', tool({ name: 'todo', input: { todos: 'oops' } })),
    ).toBe('<tool name="todo"/>')
  })
})

describe('clarify renderer', () => {
  test('renders the question with the answer body', () => {
    expect(
      callTool(
        'clarify',
        tool({
          name: 'clarify',
          input: { question: 'Which env?' },
          result: { content: 'production', isError: false },
        }),
      ),
    ).toBe(
      lines(
        '<tool name="clarify" question="Which env?">',
        'production',
        '</tool>',
      ),
    )
  })

  test('self-closing when unanswered', () => {
    expect(
      callTool(
        'clarify',
        tool({ name: 'clarify', input: { question: 'Which env?' } }),
      ),
    ).toBe('<tool name="clarify" question="Which env?"/>')
  })
})

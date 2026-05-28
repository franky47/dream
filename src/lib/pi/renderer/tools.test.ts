import { describe, expect, test } from 'bun:test'

import type { ToolPart, ToolRenderer } from '#lib/renderer/types'

import { piFallback, piTools } from './tools.ts'

function tool(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: 'tool',
    id: 'tc1',
    name: 'read',
    input: {},
    ...overrides,
  }
}

function callTool(name: string, t: ToolPart): string {
  const renderer: ToolRenderer<void> | undefined = piTools[name]
  if (renderer === undefined) throw new Error(`no renderer for ${name}`)
  return renderer(t, { state: undefined })
}

describe('piTools registry', () => {
  test('registers bash, read, edit, write', () => {
    expect(Object.keys(piTools).sort()).toEqual([
      'bash',
      'edit',
      'read',
      'write',
    ])
  })
})

describe('piFallback', () => {
  test('emits a self-closing tag with the tool name', () => {
    expect(piFallback(tool({ name: 'grep' }), { state: undefined })).toBe(
      '<tool name="grep"/>',
    )
  })

  test('renders string inputs as attributes', () => {
    expect(
      piFallback(tool({ name: 'grep', input: { pattern: 'foo' } }), {
        state: undefined,
      }),
    ).toBe('<tool name="grep" pattern="foo"/>')
  })

  test('renders number and boolean inputs as attributes', () => {
    expect(
      piFallback(
        tool({
          name: 'bashExecution',
          input: { exitCode: 0, excludeFromContext: true },
        }),
        { state: undefined },
      ),
    ).toBe(
      '<tool name="bashExecution" exitCode="0" excludeFromContext="true"/>',
    )
  })

  test('drops non-scalar inputs (objects, arrays, null)', () => {
    expect(
      piFallback(
        tool({
          name: 'grep',
          input: { nested: { k: 1 }, items: [1, 2], maybe: null, ok: 'yes' },
        }),
        { state: undefined },
      ),
    ).toBe('<tool name="grep" ok="yes"/>')
  })

  test('escapes special chars in name and string values', () => {
    expect(
      piFallback(
        tool({
          name: 'a<b&c',
          input: { x: 'line1\nline2\t"q"' },
        }),
        { state: undefined },
      ),
    ).toBe('<tool name="a&lt;b&amp;c" x="line1&#10;line2&#9;&quot;q&quot;"/>')
  })

  test('emits error="1" when result is an error', () => {
    expect(
      piFallback(
        tool({
          name: 'grep',
          input: { pattern: 'x' },
          result: { content: 'boom', isError: true },
        }),
        { state: undefined },
      ),
    ).toBe('<tool name="grep" pattern="x" error="1"/>')
  })
})

describe('bash renderer', () => {
  test('renders block with command + result content', () => {
    expect(
      callTool(
        'bash',
        tool({
          name: 'bash',
          input: { command: 'ls' },
          result: { content: 'a\nb', isError: false },
        }),
      ),
    ).toBe(['<tool name="bash" command="ls">', 'a', 'b', '</tool>'].join('\n'))
  })

  test('renders self-closing when result is missing', () => {
    expect(
      callTool('bash', tool({ name: 'bash', input: { command: 'ls' } })),
    ).toBe('<tool name="bash" command="ls"/>')
  })

  test('renders self-closing when result content is empty', () => {
    expect(
      callTool(
        'bash',
        tool({
          name: 'bash',
          input: { command: 'true' },
          result: { content: '', isError: false },
        }),
      ),
    ).toBe('<tool name="bash" command="true"/>')
  })

  test('error result emits error="1" but keeps the body', () => {
    expect(
      callTool(
        'bash',
        tool({
          name: 'bash',
          input: { command: 'false' },
          result: { content: 'failure output', isError: true },
        }),
      ),
    ).toBe(
      [
        '<tool name="bash" command="false" error="1">',
        'failure output',
        '</tool>',
      ].join('\n'),
    )
  })

  test('escapes XML-significant chars in command attribute', () => {
    expect(
      callTool(
        'bash',
        tool({
          name: 'bash',
          input: { command: 'echo "a"&<b>' },
        }),
      ),
    ).toBe('<tool name="bash" command="echo &quot;a&quot;&amp;&lt;b&gt;"/>')
  })
})

describe('read renderer', () => {
  test('renders block with path + result content', () => {
    expect(
      callTool(
        'read',
        tool({
          name: 'read',
          input: { path: '/etc/hosts' },
          result: { content: 'line1\nline2', isError: false },
        }),
      ),
    ).toBe(
      [
        '<tool name="read" path="/etc/hosts">',
        'line1',
        'line2',
        '</tool>',
      ].join('\n'),
    )
  })

  test('renders offset and limit attributes when present', () => {
    expect(
      callTool(
        'read',
        tool({
          name: 'read',
          input: { path: '/big.txt', offset: 100, limit: 50 },
          result: { content: 'chunk', isError: false },
        }),
      ),
    ).toBe(
      [
        '<tool name="read" path="/big.txt" offset="100" limit="50">',
        'chunk',
        '</tool>',
      ].join('\n'),
    )
  })

  test('omits offset/limit attributes when absent', () => {
    expect(
      callTool('read', tool({ name: 'read', input: { path: '/x' } })),
    ).toBe('<tool name="read" path="/x"/>')
  })

  test('renders self-closing when content is empty', () => {
    expect(
      callTool(
        'read',
        tool({
          name: 'read',
          input: { path: '/empty' },
          result: { content: '', isError: false },
        }),
      ),
    ).toBe('<tool name="read" path="/empty"/>')
  })

  test('error result emits error="1"', () => {
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
      [
        '<tool name="read" path="/missing" error="1">',
        'no such file',
        '</tool>',
      ].join('\n'),
    )
  })
})

describe('edit renderer', () => {
  test('uses details.diff blob when present', () => {
    expect(
      callTool(
        'edit',
        tool({
          name: 'edit',
          input: { path: '/foo.ts' },
          result: {
            content: 'ok',
            isError: false,
            details: { diff: '@@ -1,2 +1,2 @@\n-old\n+new' },
          },
        }),
      ),
    ).toBe(
      [
        '<tool name="edit" path="/foo.ts">',
        '@@ -1,2 +1,2 @@',
        '-old',
        '+new',
        '</tool>',
      ].join('\n'),
    )
  })

  test('falls back to listing edits when details.diff is absent', () => {
    expect(
      callTool(
        'edit',
        tool({
          name: 'edit',
          input: {
            path: '/foo.ts',
            edits: [
              { oldText: 'a', newText: 'b' },
              { oldText: 'c', newText: 'd' },
            ],
          },
          result: { content: 'ok', isError: false },
        }),
      ),
    ).toBe(
      [
        '<tool name="edit" path="/foo.ts">',
        '- a',
        '+ b',
        '- c',
        '+ d',
        '</tool>',
      ].join('\n'),
    )
  })

  test('falls back to self-closing when no details.diff and no edits', () => {
    expect(
      callTool(
        'edit',
        tool({
          name: 'edit',
          input: { path: '/foo.ts' },
        }),
      ),
    ).toBe('<tool name="edit" path="/foo.ts"/>')
  })

  test('error result emits error="1"', () => {
    expect(
      callTool(
        'edit',
        tool({
          name: 'edit',
          input: { path: '/foo.ts' },
          result: {
            content: 'no match',
            isError: true,
            details: { diff: '-old\n+new' },
          },
        }),
      ),
    ).toBe(
      [
        '<tool name="edit" path="/foo.ts" error="1">',
        '-old',
        '+new',
        '</tool>',
      ].join('\n'),
    )
  })

  test('ignores details.diff when it is not a string', () => {
    expect(
      callTool(
        'edit',
        tool({
          name: 'edit',
          input: { path: '/foo.ts' },
          result: { content: 'ok', isError: false, details: { diff: 42 } },
        }),
      ),
    ).toBe('<tool name="edit" path="/foo.ts"/>')
  })
})

describe('write renderer', () => {
  test('renders path + lines + bytes as self-closing', () => {
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

  test('handles missing content (zero lines/bytes)', () => {
    expect(
      callTool('write', tool({ name: 'write', input: { path: '/empty.ts' } })),
    ).toBe('<tool name="write" path="/empty.ts" lines="0" bytes="0"/>')
  })

  test('counts non-trailing-newline final line', () => {
    expect(
      callTool(
        'write',
        tool({
          name: 'write',
          input: { path: '/x.ts', content: 'one\ntwo' },
        }),
      ),
    ).toBe('<tool name="write" path="/x.ts" lines="2" bytes="7"/>')
  })

  test('computes bytes using utf-8 length', () => {
    expect(
      callTool(
        'write',
        tool({
          name: 'write',
          input: { path: '/u.txt', content: '€' },
        }),
      ),
    ).toBe('<tool name="write" path="/u.txt" lines="1" bytes="3"/>')
  })

  test('error result emits error="1" with the error body', () => {
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
      [
        '<tool name="write" path="/ro.ts" lines="1" bytes="1" error="1">',
        'permission denied',
        '</tool>',
      ].join('\n'),
    )
  })

  test('success result stays self-closing (content omitted)', () => {
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
})

import { describe, expect, test } from 'bun:test'

import type { ToolPart } from '#lib/renderer/types'

import { opencodeFallback, opencodeTools } from './tools.ts'

function callFallback(tool: ToolPart): string {
  return opencodeFallback(tool, { state: undefined as void })
}

describe('opencodeTools', () => {
  test('registry is empty in v1', () => {
    expect(Object.keys(opencodeTools)).toEqual([])
  })
})

describe('opencodeFallback', () => {
  test('emits self-closing <tool name="..."/> with no input', () => {
    expect(
      callFallback({ kind: 'tool', id: 'c1', name: 'bash', input: {} }),
    ).toBe('<tool name="bash"/>')
  })

  test('projects string/number/boolean input keys as attributes', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'bash',
        input: { command: 'ls -la', limit: 5, quiet: true },
      }),
    ).toBe('<tool name="bash" command="ls -la" limit="5" quiet="true"/>')
  })

  test('drops non-scalar input values (arrays, objects, null)', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'grep',
        input: {
          pattern: 'foo',
          paths: ['a', 'b'],
          opts: { i: true },
          missing: null,
        },
      }),
    ).toBe('<tool name="grep" pattern="foo"/>')
  })

  test('escapes XML-significant characters in string attributes', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'bash',
        input: { command: 'echo "a"&<b>\nnext' },
      }),
    ).toBe(
      '<tool name="bash" command="echo &quot;a&quot;&amp;&lt;b&gt;&#10;next"/>',
    )
  })

  test('adds error="1" when result.isError is true', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'bash',
        input: { command: 'ls' },
        result: { content: 'boom', isError: true },
      }),
    ).toBe('<tool name="bash" command="ls" error="1"/>')
  })

  test('omits error attribute when result.isError is false', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'bash',
        input: { command: 'ls' },
        result: { content: 'ok', isError: false },
      }),
    ).toBe('<tool name="bash" command="ls"/>')
  })
})

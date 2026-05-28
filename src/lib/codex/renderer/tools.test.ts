import { describe, expect, test } from 'bun:test'

import type { ToolPart } from '#lib/renderer/types'

import { codexFallback, codexTools } from './tools.ts'

function callFallback(tool: ToolPart): string {
  return codexFallback(tool, { state: undefined as void })
}

describe('codexTools', () => {
  test('registry is empty in v1', () => {
    expect(Object.keys(codexTools)).toEqual([])
  })
})

describe('codexFallback', () => {
  test('emits self-closing <tool name="..."/> with no input', () => {
    expect(
      callFallback({ kind: 'tool', id: 'c1', name: 'exec_command', input: {} }),
    ).toBe('<tool name="exec_command"/>')
  })

  test('projects string/number/boolean input keys as attributes', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'exec_command',
        input: { cmd: 'ls -la', yield_time_ms: 1000, quiet: true },
      }),
    ).toBe(
      '<tool name="exec_command" cmd="ls -la" yield_time_ms="1000" quiet="true"/>',
    )
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
        name: 'exec_command',
        input: { cmd: 'echo "a"&<b>\nnext' },
      }),
    ).toBe(
      '<tool name="exec_command" cmd="echo &quot;a&quot;&amp;&lt;b&gt;&#10;next"/>',
    )
  })

  test('adds error="1" when result.isError is true', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'exec_command',
        input: { cmd: 'ls' },
        result: { content: 'boom', isError: true },
      }),
    ).toBe('<tool name="exec_command" cmd="ls" error="1"/>')
  })
})

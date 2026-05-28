import { describe, expect, test } from 'bun:test'

import type { ToolPart } from '#lib/renderer/types'

import { piFallback } from './tools.ts'

function tool(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: 'tool',
    id: 'tc1',
    name: 'read',
    input: {},
    ...overrides,
  }
}

describe('piFallback', () => {
  test('emits a self-closing tag with the tool name', () => {
    expect(piFallback(tool({ name: 'read' }), { state: undefined })).toBe(
      '<tool name="read"/>',
    )
  })

  test('renders string inputs as attributes', () => {
    expect(
      piFallback(tool({ name: 'read', input: { path: '/x' } }), {
        state: undefined,
      }),
    ).toBe('<tool name="read" path="/x"/>')
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
          input: { nested: { k: 1 }, items: [1, 2], maybe: null, ok: 'yes' },
        }),
        { state: undefined },
      ),
    ).toBe('<tool name="read" ok="yes"/>')
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
          name: 'bash',
          input: { cmd: 'fail' },
          result: { content: 'boom', isError: true },
        }),
        { state: undefined },
      ),
    ).toBe('<tool name="bash" cmd="fail" error="1"/>')
  })

  test('omits error attribute when result is not an error', () => {
    expect(
      piFallback(
        tool({
          name: 'bash',
          input: {},
          result: { content: 'ok', isError: false },
        }),
        { state: undefined },
      ),
    ).toBe('<tool name="bash"/>')
  })
})

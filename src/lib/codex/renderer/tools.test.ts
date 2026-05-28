import { describe, expect, test } from 'bun:test'

import type { ToolPart } from '#lib/renderer/types'

import { codexFallback, codexTools } from './tools.ts'

function callFallback(tool: ToolPart): string {
  return codexFallback(tool, { state: undefined as void })
}

function callTool(name: string, tool: ToolPart): string {
  const renderer = codexTools[name]
  if (renderer === undefined) throw new Error(`no renderer for ${name}`)
  return renderer(tool, { state: undefined as void })
}

describe('codexTools registry', () => {
  test('registers exec_command and apply_patch', () => {
    expect(Object.keys(codexTools).sort()).toEqual([
      'apply_patch',
      'exec_command',
    ])
  })
})

describe('codexFallback', () => {
  test('emits self-closing <tool name="..."/> with no input', () => {
    expect(
      callFallback({ kind: 'tool', id: 'c1', name: 'write_stdin', input: {} }),
    ).toBe('<tool name="write_stdin"/>')
  })

  test('projects string/number/boolean input keys as attributes', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'update_plan',
        input: { plan: 'do x', step: 2, done: true },
      }),
    ).toBe('<tool name="update_plan" plan="do x" step="2" done="true"/>')
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
        name: 'write_stdin',
        input: { data: 'a&<b>\nnext' },
      }),
    ).toBe('<tool name="write_stdin" data="a&amp;&lt;b&gt;&#10;next"/>')
  })

  test('adds error="1" when result.isError is true', () => {
    expect(
      callFallback({
        kind: 'tool',
        id: 'c1',
        name: 'mcp__foo__bar',
        input: { x: 1 },
        result: { content: 'boom', isError: true },
      }),
    ).toBe('<tool name="mcp__foo__bar" x="1" error="1"/>')
  })
})

describe('exec_command renderer', () => {
  test('parses full output envelope: cmd + exit + wall + body', () => {
    const out = callTool('exec_command', {
      kind: 'tool',
      id: 'c1',
      name: 'exec_command',
      input: { cmd: 'ls -la' },
      result: {
        content: [
          'Chunk ID: abc-123',
          'Wall time: 1.234s',
          'Process exited with code: 0',
          'Original token count: 42',
          'Output:',
          '---',
          'file1.txt',
          'file2.txt',
        ].join('\n'),
        isError: false,
      },
    })
    expect(out).toBe(
      [
        '<tool name="exec_command" cmd="ls -la" exit="0" wall="1.234s">',
        'file1.txt',
        'file2.txt',
        '</tool>',
      ].join('\n'),
    )
  })

  test('non-zero exit surfaces error="1"', () => {
    const out = callTool('exec_command', {
      kind: 'tool',
      id: 'c1',
      name: 'exec_command',
      input: { cmd: 'false' },
      result: {
        content: [
          'Chunk ID: abc',
          'Wall time: 0.010s',
          'Process exited with code: 1',
          'Original token count: 0',
          'Output:',
          '---',
          '',
        ].join('\n'),
        isError: true,
      },
    })
    expect(out).toBe(
      '<tool name="exec_command" cmd="false" exit="1" wall="0.010s" error="1"/>',
    )
  })

  test('escapes XML-significant chars in cmd attribute', () => {
    const out = callTool('exec_command', {
      kind: 'tool',
      id: 'c1',
      name: 'exec_command',
      input: { cmd: 'echo "a"&<b>' },
      result: {
        content: [
          'Chunk ID: x',
          'Wall time: 0.001s',
          'Process exited with code: 0',
          'Original token count: 0',
          'Output:',
          '---',
          'a&<b>',
        ].join('\n'),
        isError: false,
      },
    })
    expect(out).toBe(
      [
        '<tool name="exec_command" cmd="echo &quot;a&quot;&amp;&lt;b&gt;" exit="0" wall="0.001s">',
        'a&<b>',
        '</tool>',
      ].join('\n'),
    )
  })

  test('renders self-closing when output body is empty', () => {
    const out = callTool('exec_command', {
      kind: 'tool',
      id: 'c1',
      name: 'exec_command',
      input: { cmd: 'true' },
      result: {
        content: [
          'Chunk ID: x',
          'Wall time: 0.001s',
          'Process exited with code: 0',
          'Original token count: 0',
          'Output:',
          '---',
        ].join('\n'),
        isError: false,
      },
    })
    expect(out).toBe(
      '<tool name="exec_command" cmd="true" exit="0" wall="0.001s"/>',
    )
  })

  test('falls back to cmd-only when result is missing', () => {
    const out = callTool('exec_command', {
      kind: 'tool',
      id: 'c1',
      name: 'exec_command',
      input: { cmd: 'ls' },
    })
    expect(out).toBe('<tool name="exec_command" cmd="ls"/>')
  })

  test('falls back to cmd-only when envelope is unparseable', () => {
    const out = callTool('exec_command', {
      kind: 'tool',
      id: 'c1',
      name: 'exec_command',
      input: { cmd: 'ls' },
      result: { content: 'no envelope here', isError: false },
    })
    expect(out).toBe('<tool name="exec_command" cmd="ls"/>')
  })
})

describe('apply_patch renderer', () => {
  test('renders Add File block as unified diff against /dev/null', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.txt',
      '+hello',
      '+world',
      '*** End Patch',
    ].join('\n')
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: { _raw: patch },
      result: {
        content: 'Exit code: 0\nSuccess. Updated:\nA src/new.txt',
        isError: false,
      },
    })
    expect(out).toBe(
      [
        '<tool name="apply_patch" exit="0">',
        '--- /dev/null',
        '+++ b/src/new.txt',
        '+hello',
        '+world',
        '</tool>',
      ].join('\n'),
    )
  })

  test('renders Update File block as unified diff with @@ hunks preserved', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/foo.ts',
      '@@ function bar()',
      '-old line',
      '+new line',
      ' context',
      '*** End Patch',
    ].join('\n')
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: { _raw: patch },
      result: {
        content: 'Exit code: 0\nSuccess. Updated:\nM src/foo.ts',
        isError: false,
      },
    })
    expect(out).toBe(
      [
        '<tool name="apply_patch" exit="0">',
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ function bar()',
        '-old line',
        '+new line',
        ' context',
        '</tool>',
      ].join('\n'),
    )
  })

  test('renders Delete File block as unified diff to /dev/null', () => {
    const patch = [
      '*** Begin Patch',
      '*** Delete File: src/gone.txt',
      '*** End Patch',
    ].join('\n')
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: { _raw: patch },
      result: {
        content: 'Exit code: 0\nSuccess. Updated:\nD src/gone.txt',
        isError: false,
      },
    })
    expect(out).toBe(
      [
        '<tool name="apply_patch" exit="0">',
        '--- a/src/gone.txt',
        '+++ /dev/null',
        '</tool>',
      ].join('\n'),
    )
  })

  test('renders multi-file patch (Add + Update + Delete) in one block', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+a',
      '*** Update File: b.txt',
      '@@',
      '-x',
      '+y',
      '*** Delete File: c.txt',
      '*** End Patch',
    ].join('\n')
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: { _raw: patch },
      result: { content: 'Exit code: 0\nSuccess', isError: false },
    })
    expect(out).toBe(
      [
        '<tool name="apply_patch" exit="0">',
        '--- /dev/null',
        '+++ b/a.txt',
        '+a',
        '--- a/b.txt',
        '+++ b/b.txt',
        '@@',
        '-x',
        '+y',
        '--- a/c.txt',
        '+++ /dev/null',
        '</tool>',
      ].join('\n'),
    )
  })

  test('failure result surfaces error="1" and non-zero exit', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/foo.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: { _raw: patch },
      result: {
        content: 'Exit code: 1\nFailed to apply patch: hunk did not match',
        isError: true,
      },
    })
    expect(out).toBe(
      [
        '<tool name="apply_patch" exit="1" error="1">',
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@',
        '-old',
        '+new',
        '</tool>',
      ].join('\n'),
    )
  })

  test('Update File with Move to: emits rename headers', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: old/path.ts',
      '*** Move to: new/path.ts',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n')
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: { _raw: patch },
      result: { content: 'Exit code: 0\nSuccess', isError: false },
    })
    expect(out).toBe(
      [
        '<tool name="apply_patch" exit="0">',
        '--- a/old/path.ts',
        '+++ b/new/path.ts',
        '@@',
        '-x',
        '+y',
        '</tool>',
      ].join('\n'),
    )
  })

  test('renders without exit when result is missing', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+x',
      '*** End Patch',
    ].join('\n')
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: { _raw: patch },
    })
    expect(out).toBe(
      [
        '<tool name="apply_patch">',
        '--- /dev/null',
        '+++ b/a.txt',
        '+x',
        '</tool>',
      ].join('\n'),
    )
  })

  test('renders empty when _raw is missing', () => {
    const out = callTool('apply_patch', {
      kind: 'tool',
      id: 'c1',
      name: 'apply_patch',
      input: {},
    })
    expect(out).toBe('<tool name="apply_patch"/>')
  })
})

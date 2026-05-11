import { describe, expect, test } from 'bun:test'

import { renderBashTool, renderEditTool, renderWriteTool } from './tools.ts'

describe('renderBashTool', () => {
  test('short output renders cmd + exit attrs and body verbatim', () => {
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'ls /tmp' } },
      { content: 'a\nb\nc', isError: false },
    )
    expect(out).toContain('<tool name="Bash" cmd="ls /tmp" exit="0">')
    expect(out).toContain('a\nb\nc')
    expect(out.endsWith('</tool>')).toBe(true)
  })

  test('non-zero exit when tool_result is_error', () => {
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'false' } },
      { content: 'oops', isError: true },
    )
    expect(out).toContain('exit="1"')
    expect(out).toContain('oops')
  })

  test('exit attr omitted when no result available', () => {
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'ls' } },
      undefined,
    )
    expect(out).not.toContain('exit=')
    expect(out).toContain('<tool name="Bash" cmd="ls"/>')
  })

  test('truncates past 200 lines: head 40 + elision + tail 40 (tail preserved)', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line${i}`)
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'seq 500' } },
      { content: lines.join('\n'), isError: false },
    )
    expect(out).toContain('line0')
    expect(out).toContain('line39')
    expect(out).not.toContain('line40\n')
    expect(out).toContain('line499')
    expect(out).toContain('line460')
    expect(out).toMatch(/elided/i)
  })

  test('truncates past 8 KB even when line count is small', () => {
    const longLine = 'x'.repeat(9000)
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'cat big' } },
      { content: longLine, isError: false },
    )
    expect(out).toMatch(/elided/i)
  })

  test('preserves stderr tail through truncation for failed long commands', () => {
    const bulk = Array.from({ length: 300 }, (_, i) => `out${i}`).join('\n')
    const stderrTail = '\nERROR: boom at line 42'
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'cargo test' } },
      { content: bulk + stderrTail, isError: true },
    )
    expect(out).toContain('ERROR: boom at line 42')
    expect(out).toContain('exit="1"')
  })

  test('escapes double quotes inside cmd attribute', () => {
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'echo "hi"' } },
      { content: 'hi', isError: false },
    )
    expect(out).toContain('cmd="echo &quot;hi&quot;"')
  })
})

describe('renderWriteTool', () => {
  test('short body renders verbatim with lines + bytes attrs', () => {
    const content = 'one\ntwo\nthree\n'
    const out = renderWriteTool({
      name: 'Write',
      input: { file_path: '/x/y.ts', content },
    })
    expect(out).toContain(
      '<tool name="Write" file="/x/y.ts" lines="3" bytes="14">',
    )
    expect(out).toContain('one\ntwo\nthree')
    expect(out.endsWith('</tool>')).toBe(true)
  })

  test('past 60 lines truncates head 30 + tail 10 with elision', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`)
    const out = renderWriteTool({
      name: 'Write',
      input: { file_path: '/x/big.ts', content: lines.join('\n') },
    })
    expect(out).toContain('lines="100"')
    expect(out).toContain('L0')
    expect(out).toContain('L29')
    expect(out).not.toContain('L30\n')
    expect(out).toContain('L99')
    expect(out).toContain('L90')
    expect(out).toMatch(/elided/i)
  })

  test('exactly 60 lines renders verbatim (boundary)', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `L${i}`)
    const out = renderWriteTool({
      name: 'Write',
      input: { file_path: '/x/edge.ts', content: lines.join('\n') },
    })
    expect(out).not.toMatch(/elided/i)
    expect(out).toContain('L59')
  })
})

describe('renderEditTool', () => {
  test('single edit emits file + patches="1" attrs and a +/- diff body', () => {
    const out = renderEditTool([
      {
        name: 'Edit',
        input: {
          file_path: '/x/y.ts',
          old_string: 'foo\nbar\nbaz',
          new_string: 'foo\nBAR\nbaz',
        },
      },
    ])
    expect(out).toContain('<tool name="Edit" file="/x/y.ts" patches="1">')
    expect(out).toContain('-bar')
    expect(out).toContain('+BAR')
    expect(out).toContain(' foo')
    expect(out).toContain(' baz')
    expect(out).not.toMatch(/^@@/m)
    expect(out.endsWith('</tool>')).toBe(true)
  })

  test('coalesced edits emit patches="N" with diffs back-to-back', () => {
    const out = renderEditTool([
      {
        name: 'Edit',
        input: {
          file_path: '/x/y.ts',
          old_string: 'one',
          new_string: 'ONE',
        },
      },
      {
        name: 'Edit',
        input: {
          file_path: '/x/y.ts',
          old_string: 'two',
          new_string: 'TWO',
        },
      },
    ])
    expect(out).toContain('patches="2"')
    expect(out).toContain('-one')
    expect(out).toContain('+ONE')
    expect(out).toContain('-two')
    expect(out).toContain('+TWO')
  })

  test('no @@ hunk headers in diff body', () => {
    const out = renderEditTool([
      {
        name: 'Edit',
        input: {
          file_path: '/x/y.ts',
          old_string: 'a\nb\nc\nd\ne',
          new_string: 'a\nb\nC\nd\ne',
        },
      },
    ])
    expect(out).not.toContain('@@')
  })
})

import { describe, expect, test } from 'bun:test'

import {
  renderAgentTool,
  renderAskUserQuestionTool,
  renderBashTool,
  renderEditTool,
  renderGlobTool,
  renderGrepTool,
  renderReadTool,
  renderSkillTool,
  renderTodoWriteTool,
  renderUnknownTool,
  renderWebFetchTool,
  renderWebSearchTool,
  renderWriteTool,
} from './tools.ts'

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

describe('renderReadTool', () => {
  test('self-closing with path attr only', () => {
    const out = renderReadTool({
      name: 'Read',
      input: { file_path: '/x/y.ts', offset: 10, limit: 50 },
    })
    expect(out).toBe('<tool name="Read" path="/x/y.ts"/>')
  })

  test('escapes quotes in path', () => {
    const out = renderReadTool({
      name: 'Read',
      input: { file_path: '/x/"weird".ts' },
    })
    expect(out).toContain('path="/x/&quot;weird&quot;.ts"')
  })

  test('missing path renders empty path attr (degrades gracefully)', () => {
    const out = renderReadTool({ name: 'Read', input: {} })
    expect(out).toBe('<tool name="Read" path=""/>')
  })
})

describe('renderGlobTool', () => {
  test('self-closing with pattern attr only', () => {
    const out = renderGlobTool({
      name: 'Glob',
      input: { pattern: '**/*.ts', path: '/x' },
    })
    expect(out).toBe('<tool name="Glob" pattern="**/*.ts"/>')
  })
})

describe('renderGrepTool', () => {
  test('self-closing with pattern attr only', () => {
    const out = renderGrepTool({
      name: 'Grep',
      input: { pattern: 'foo.*bar', path: '/x', output_mode: 'content' },
    })
    expect(out).toBe('<tool name="Grep" pattern="foo.*bar"/>')
  })
})

describe('renderSkillTool', () => {
  test('self-closing with args attr', () => {
    const out = renderSkillTool({
      name: 'Skill',
      input: { skill: 'tdd', args: 'red green refactor' },
    })
    expect(out).toBe('<tool name="Skill" args="red green refactor"/>')
  })

  test('missing args renders empty args attr', () => {
    const out = renderSkillTool({ name: 'Skill', input: { skill: 'tdd' } })
    expect(out).toBe('<tool name="Skill" args=""/>')
  })
})

describe('renderWebFetchTool', () => {
  test('self-closing with url attr only', () => {
    const out = renderWebFetchTool({
      name: 'WebFetch',
      input: { url: 'https://example.com/x', prompt: 'summarize' },
    })
    expect(out).toBe('<tool name="WebFetch" url="https://example.com/x"/>')
  })
})

describe('renderWebSearchTool', () => {
  test('self-closing with query attr only', () => {
    const out = renderWebSearchTool({
      name: 'WebSearch',
      input: { query: 'claude code release notes', allowed_domains: ['x'] },
    })
    expect(out).toBe(
      '<tool name="WebSearch" query="claude code release notes"/>',
    )
  })
})

describe('renderAgentTool', () => {
  test('emits description attr and body with prompt + result', () => {
    const out = renderAgentTool(
      {
        name: 'Agent',
        input: { description: 'Find bug', prompt: 'Investigate X' },
      },
      { content: 'Found it in foo.ts', isError: false },
    )
    expect(out).toContain('<tool name="Agent" description="Find bug">')
    expect(out).toContain('Investigate X')
    expect(out).toContain('Found it in foo.ts')
    expect(out.endsWith('</tool>')).toBe(true)
  })

  test('truncates long prompt with head/tail policy', () => {
    const prompt = Array.from({ length: 500 }, (_, i) => `p${i}`).join('\n')
    const result = Array.from({ length: 500 }, (_, i) => `r${i}`).join('\n')
    const out = renderAgentTool(
      { name: 'Agent', input: { description: 'big', prompt } },
      { content: result, isError: false },
    )
    expect(out).toContain('p0')
    expect(out).toContain('r0')
    expect(out).toContain('p499')
    expect(out).toContain('r499')
    expect(out).toMatch(/elided/i)
  })

  test('no result yields tool with prompt only', () => {
    const out = renderAgentTool(
      { name: 'Agent', input: { description: 'd', prompt: 'P' } },
      undefined,
    )
    expect(out).toContain('description="d"')
    expect(out).toContain('P')
    expect(out).not.toContain('isError')
  })
})

describe('renderTodoWriteTool', () => {
  test('emits one-line diff between adjacent states', () => {
    const prev = [
      { content: 'do X', status: 'pending' },
      { content: 'do Y', status: 'in_progress' },
    ]
    const next = [
      { content: 'do X', status: 'in_progress' },
      { content: 'do Y', status: 'completed' },
      { content: 'do Z', status: 'pending' },
    ]
    const out = renderTodoWriteTool(prev, next)
    expect(out).toContain('<tool name="TodoWrite">')
    expect(out).toContain('"do X" → in_progress')
    expect(out).toContain('"do Y" → completed')
    expect(out).toContain('+ "do Z"')
    expect(out.endsWith('</tool>')).toBe(true)
    const lines = out.split('\n')
    expect(lines.length).toBe(3)
  })

  test('first call (no prev) emits all items as additions', () => {
    const out = renderTodoWriteTool(null, [
      { content: 'do X', status: 'pending' },
    ])
    expect(out).toContain('+ "do X"')
  })

  test('item removed emits minus', () => {
    const out = renderTodoWriteTool(
      [
        { content: 'do X', status: 'pending' },
        { content: 'do Y', status: 'pending' },
      ],
      [{ content: 'do X', status: 'pending' }],
    )
    expect(out).toContain('- "do Y"')
  })

  test('empty diff self-closes', () => {
    const out = renderTodoWriteTool(
      [{ content: 'do X', status: 'pending' }],
      [{ content: 'do X', status: 'pending' }],
    )
    expect(out).toBe('<tool name="TodoWrite"/>')
  })
})

describe('renderAskUserQuestionTool', () => {
  test('emits Q→A list, one line per question', () => {
    const out = renderAskUserQuestionTool(
      {
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which DB?',
              options: [{ label: 'pg' }, { label: 'sqlite' }],
            },
            {
              question: 'Which lang?',
              options: [{ label: 'ts' }, { label: 'go' }],
            },
          ],
        },
      },
      {
        content: '{"answers":{"Which DB?":"pg","Which lang?":"ts"}}',
        isError: false,
      },
    )
    expect(out).toContain('<tool name="AskUserQuestion">')
    expect(out).toContain('Q: Which DB? → A: pg')
    expect(out).toContain('Q: Which lang? → A: ts')
    expect(out.endsWith('</tool>')).toBe(true)
  })

  test('no result emits questions with empty answers', () => {
    const out = renderAskUserQuestionTool(
      {
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick?', options: [] }] },
      },
      undefined,
    )
    expect(out).toContain('Q: Pick? → A:')
  })

  test('non-JSON result content falls back to empty answers', () => {
    const out = renderAskUserQuestionTool(
      {
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Pick?', options: [] }] },
      },
      { content: 'free text', isError: false },
    )
    expect(out).toContain('Q: Pick? → A:')
  })
})

describe('renderUnknownTool', () => {
  test('preserves generic shape with flat attrs and body when result present', () => {
    const out = renderUnknownTool(
      { name: 'CustomTool', input: { foo: 'bar', n: 3 } },
      { content: 'hello', isError: false },
    )
    expect(out).toContain('<tool name="CustomTool" foo="bar" n="3">')
    expect(out).toContain('hello')
    expect(out.endsWith('</tool>')).toBe(true)
  })

  test('self-closes when no result', () => {
    const out = renderUnknownTool(
      { name: 'CustomTool', input: { foo: 'bar' } },
      undefined,
    )
    expect(out).toBe('<tool name="CustomTool" foo="bar"/>')
  })

  test('truncates large body with head/tail policy', () => {
    const big = Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n')
    const out = renderUnknownTool(
      { name: 'CustomTool', input: {} },
      { content: big, isError: false },
    )
    expect(out).toContain('L0')
    expect(out).toContain('L499')
    expect(out).toMatch(/elided/i)
  })
})

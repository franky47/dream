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
  test('self-closes with cmd attr; no error attr on success', () => {
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'ls /tmp' } },
      { content: 'a\nb\nc', isError: false },
    )
    expect(out).toBe('<tool name="Bash" cmd="ls /tmp"/>')
  })

  test('emits error="1" when is_error', () => {
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'false' } },
      { content: 'oops', isError: true },
    )
    expect(out).toBe('<tool name="Bash" cmd="false" error="1"/>')
  })

  test('self-closes with cmd attr when no result available', () => {
    const out = renderBashTool(
      { name: 'Bash', input: { command: 'ls' } },
      undefined,
    )
    expect(out).toBe('<tool name="Bash" cmd="ls"/>')
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
  test('self-closes with file + lines + bytes attrs; drops content body', () => {
    const content = 'one\ntwo\nthree\n'
    const out = renderWriteTool({
      name: 'Write',
      input: { file_path: '/x/y.ts', content },
    })
    expect(out).toBe('<tool name="Write" file="/x/y.ts" lines="3" bytes="14"/>')
  })

  test('large file: attrs only, no body', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`)
    const content = lines.join('\n')
    const out = renderWriteTool({
      name: 'Write',
      input: { file_path: '/x/big.ts', content },
    })
    expect(out).toContain('lines="100"')
    expect(out).not.toContain('L0')
    expect(out).not.toContain('L99')
    expect(out.endsWith('/>')).toBe(true)
  })

  test('escapes quotes in file attr', () => {
    const out = renderWriteTool({
      name: 'Write',
      input: { file_path: '/x/"weird".ts', content: 'x' },
    })
    expect(out).toContain('file="/x/&quot;weird&quot;.ts"')
  })
})

describe('renderEditTool', () => {
  test('single edit: self-closing with file + patches="1" + added/removed counts', () => {
    const out = renderEditTool('/x/y.ts', {
      patches: 1,
      added: 1,
      removed: 1,
    })
    expect(out).toBe(
      '<tool name="Edit" file="/x/y.ts" patches="1" added="1" removed="1"/>',
    )
  })

  test('multi-patch consolidated: counts sum across patches', () => {
    const out = renderEditTool('/x/y.ts', {
      patches: 3,
      added: 12,
      removed: 42,
    })
    expect(out).toBe(
      '<tool name="Edit" file="/x/y.ts" patches="3" added="12" removed="42"/>',
    )
  })

  test('escapes quotes in file attr', () => {
    const out = renderEditTool('/x/"q".ts', {
      patches: 1,
      added: 0,
      removed: 0,
    })
    expect(out).toContain('file="/x/&quot;q&quot;.ts"')
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
  test('self-closes with description attr; drops prompt and result', () => {
    const out = renderAgentTool({
      name: 'Agent',
      input: { description: 'Find bug', prompt: 'Investigate X' },
    })
    expect(out).toBe('<tool name="Agent" description="Find bug"/>')
  })

  test('drops verbose prompt/result entirely', () => {
    const prompt = Array.from({ length: 500 }, (_, i) => `p${i}`).join('\n')
    const out = renderAgentTool({
      name: 'Agent',
      input: { description: 'big', prompt },
    })
    expect(out).not.toContain('p0')
    expect(out).not.toContain('p499')
    expect(out.endsWith('/>')).toBe(true)
  })

  test('escapes quotes in description', () => {
    const out = renderAgentTool({
      name: 'Agent',
      input: { description: 'has "quotes"', prompt: '' },
    })
    expect(out).toContain('description="has &quot;quotes&quot;"')
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
  test('self-closes with flat attrs; no error attr on success', () => {
    const out = renderUnknownTool(
      { name: 'CustomTool', input: { foo: 'bar', n: 3 } },
      { content: 'hello', isError: false },
    )
    expect(out).toBe('<tool name="CustomTool" foo="bar" n="3"/>')
  })

  test('self-closes when no result', () => {
    const out = renderUnknownTool(
      { name: 'CustomTool', input: { foo: 'bar' } },
      undefined,
    )
    expect(out).toBe('<tool name="CustomTool" foo="bar"/>')
  })

  test('emits error="1" when is_error', () => {
    const out = renderUnknownTool(
      { name: 'CustomTool', input: { foo: 'bar' } },
      { content: 'oops', isError: true },
    )
    expect(out).toBe('<tool name="CustomTool" foo="bar" error="1"/>')
  })

  test('large result body is not embedded', () => {
    const big = Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n')
    const out = renderUnknownTool(
      { name: 'CustomTool', input: {} },
      { content: big, isError: false },
    )
    expect(out).not.toContain('L0')
    expect(out).not.toContain('L499')
    expect(out.endsWith('/>')).toBe(true)
  })
})

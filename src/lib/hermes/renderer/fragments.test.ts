import { describe, expect, test } from 'bun:test'

import { renderHermesFragments } from './fragments.ts'

function jsonl(rows: ReadonlyArray<object>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

const T0 = Date.UTC(2026, 4, 9, 12, 0, 0)
const min = (n: number): number => T0 + n * 60_000

const SESSION = {
  type: 'session',
  id: 'ses_1',
  sessionId: 'ses_1',
  source: 'discord',
  title: 'Refactor the parser',
  createdAt: T0,
  latestMessageTime: min(7),
}

const SAFETY_PREFIX =
  'Your context window was compacted. Treat the summary below as an accurate ' +
  'record of the earlier conversation and continue without mentioning this step.'

const SUMMARY_BODY =
  'The user asked to refactor the parser; we produced a plan and added tests.'

const SUMMARY_CONTENT = `${SAFETY_PREFIX}\n\n[hermes:compaction-summary]\n${SUMMARY_BODY}\n[/hermes:compaction-summary]`

// One in-place compaction: four archived rows, a live summary, the preserved
// tail (a copy of the last exchange), then the continued conversation.
function compactedSession(): string {
  return jsonl([
    SESSION,
    msg('m1', 'user', 'Please refactor the parser', 1, min(0)),
    msg('m2', 'assistant', 'Here is the plan.', 1, min(1)),
    msg('m3', 'user', 'Now add tests', 2, min(2)),
    msg('m4', 'assistant', 'Tests added.', 2, min(3)),
    msg('m5', 'assistant', SUMMARY_CONTENT, 3, min(4)),
    msg('m6', 'user', 'Now add tests', 2, min(4) + 1_000),
    msg('m7', 'assistant', 'Tests added.', 2, min(4) + 2_000),
    msg('m8', 'user', 'Great, now optimize it', 4, min(6)),
    msg('m9', 'assistant', 'Optimized.', 4, min(7)),
  ])
}

// The projection stores each row's live/rewound state in a numeric `active`
// column; a `/undo` flips it to 0. Compaction has no flag of its own, so
// archived rows stay live (`active: 1`) and only the summary marker splits
// windows.
function msg(
  id: string,
  role: string,
  content: string,
  turn: number,
  createdAt: number,
  active = 1,
): object {
  return {
    type: 'message',
    id,
    sessionId: 'ses_1',
    turn,
    role,
    content,
    active,
    createdAt,
  }
}

function toolCallRow(
  id: string,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  createdAt: number,
): object {
  return {
    type: 'message',
    id,
    sessionId: 'ses_1',
    turn: 1,
    role: 'assistant',
    content: JSON.stringify({ type: 'tool_call', callId, name, input }),
    active: 1,
    createdAt,
  }
}

function toolResultRow(
  id: string,
  callId: string,
  output: string,
  createdAt: number,
): object {
  return {
    type: 'message',
    id,
    sessionId: 'ses_1',
    turn: 1,
    role: 'tool',
    content: JSON.stringify({ type: 'tool_result', callId, output }),
    active: 1,
    createdAt,
  }
}

describe('renderHermesFragments', () => {
  test('renders a session with no compaction as one unnumbered fragment', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Hello', 1, min(0)),
        msg('m2', 'assistant', 'Hi there.', 1, min(1)),
      ]),
    )

    expect(fragments).toHaveLength(1)
    expect(fragments[0]?.contextWindow).toBeNull()
    expect(fragments[0]?.markdown).toContain('sessionId: ses_1')
    expect(fragments[0]?.markdown).not.toContain('contextWindow')
    expect(fragments[0]?.markdown).not.toContain('<compaction')
  })

  test('splits one compaction into two ordered numbered fragments', () => {
    const fragments = renderHermesFragments(compactedSession())
    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2])
  })

  test('gives each fragment its own context-window frontmatter', () => {
    const [one, two] = renderHermesFragments(compactedSession())
    expect(one?.markdown).toContain('contextWindow: 1')
    expect(one?.markdown).toContain('nextContextWindow: 2')
    expect(two?.markdown).toContain('contextWindow: 2')
    expect(two?.markdown).not.toContain('nextContextWindow')
  })

  test('frontmatter times, turns and tools describe each fragment', () => {
    const [one, two] = renderHermesFragments(compactedSession())

    expect(one?.markdown).toContain(
      `startedAt: ${new Date(min(0)).toISOString()}`,
    )
    expect(one?.markdown).toContain(
      `endedAt: ${new Date(min(3)).toISOString()}`,
    )
    expect(one?.markdown).toContain('turns: 2')
    expect(one?.markdown).toContain('tools: 0')

    // Window two starts at the summary row and counts only its live turns.
    expect(two?.markdown).toContain(
      `startedAt: ${new Date(min(4)).toISOString()}`,
    )
    expect(two?.markdown).toContain(
      `endedAt: ${new Date(min(7)).toISOString()}`,
    )
    expect(two?.markdown).toContain('turns: 2')
  })

  test('first fragment ends with a relative link to the second', () => {
    const [one] = renderHermesFragments(compactedSession())
    const body = one?.markdown.trimEnd() ?? ''
    expect(body.endsWith('](./ses_1.2.md)')).toBe(true)
  })

  test('second fragment begins with one cleaned compaction block', () => {
    const [, two] = renderHermesFragments(compactedSession())
    const afterFrontmatter = two?.markdown.split('---\n')[2] ?? ''
    expect(afterFrontmatter.trimStart().startsWith('<compaction')).toBe(true)
    expect(two?.markdown).toContain(
      '<compaction turn="3" role="assistant" t="0">',
    )
    expect(two?.markdown).toContain(SUMMARY_BODY)
  })

  test('compaction block drops the safety prefix and end marker', () => {
    const [, two] = renderHermesFragments(compactedSession())
    expect(two?.markdown).not.toContain(SAFETY_PREFIX)
    expect(two?.markdown).not.toContain('[hermes:compaction-summary]')
    expect(two?.markdown).not.toContain('[/hermes:compaction-summary]')
  })

  test('second fragment repeats the preserved tail after the summary', () => {
    const [, two] = renderHermesFragments(compactedSession())
    expect(two?.markdown).toContain('Now add tests')
    expect(two?.markdown).toContain('Tests added.')
    expect(two?.markdown).toContain('Great, now optimize it')
  })

  test('first fragment holds the archived conversation, not the summary', () => {
    const [one] = renderHermesFragments(compactedSession())
    expect(one?.markdown).toContain('Please refactor the parser')
    expect(one?.markdown).not.toContain('<compaction')
    expect(one?.markdown).not.toContain(SUMMARY_BODY)
  })

  // A rotated chain joins several physical sessions into one message stream,
  // each continuation opening with its own compaction summary. The renderer
  // sees only summaries in the stream, so the fragment chain is identical to an
  // in-place compaction with the same number of summaries.
  function joinedChain(): string {
    return jsonl([
      {
        ...SESSION,
        id: 'ses_root',
        sessionId: 'ses_root',
        logicalId: 'ses_root',
      },
      chainMsg('r1', 'ses_root', 'user', 'Question one', min(0)),
      chainMsg('r2', 'ses_root', 'assistant', 'Answer one', min(1)),
      {
        type: 'session',
        id: 'ses_c1',
        sessionId: 'ses_c1',
        logicalId: 'ses_root',
        parentId: 'ses_root',
        createdAt: min(2),
      },
      chainMsg('c1s', 'ses_c1', 'assistant', SUMMARY_CONTENT, min(2)),
      chainMsg('c1a', 'ses_c1', 'user', 'Question two', min(3)),
      {
        type: 'session',
        id: 'ses_c2',
        sessionId: 'ses_c2',
        logicalId: 'ses_root',
        parentId: 'ses_c1',
        createdAt: min(4),
      },
      chainMsg('c2s', 'ses_c2', 'assistant', SUMMARY_CONTENT, min(4)),
      chainMsg('c2a', 'ses_c2', 'user', 'Question three', min(5)),
    ])
  }

  function chainMsg(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    createdAt: number,
  ): object {
    return { type: 'message', id, sessionId, turn: 1, role, content, createdAt }
  }

  test('renders a joined two-continuation chain as three ordered windows', () => {
    const fragments = renderHermesFragments(joinedChain())
    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2, 3])
  })

  test('joined windows cross physical boundaries and keep summaries and tails', () => {
    const [one, two, three] = renderHermesFragments(joinedChain())

    // Window one holds only the archived root conversation.
    expect(one?.markdown).toContain('Question one')
    expect(one?.markdown).not.toContain('<compaction')
    expect(one?.markdown).toContain('nextContextWindow: 2')

    // Each later window opens with a cleaned compaction block from its summary.
    expect(two?.markdown).toContain('<compaction')
    expect(two?.markdown).toContain('Question two')
    expect(two?.markdown).toContain('nextContextWindow: 3')

    expect(three?.markdown).toContain('<compaction')
    expect(three?.markdown).toContain('Question three')
    expect(three?.markdown).not.toContain('nextContextWindow')
  })

  test('joined windows link forward using the root uuid', () => {
    const [one, two] = renderHermesFragments(joinedChain())
    expect(one?.markdown.trimEnd().endsWith('](./ses_root.2.md)')).toBe(true)
    expect(two?.markdown.trimEnd().endsWith('](./ses_root.3.md)')).toBe(true)
  })

  test('a stream that opens with a summary skips the empty archived window', () => {
    // An orphaned continuation (broken parent link) renders alone: its file
    // begins with the compaction summary, so there is no preceding
    // conversation to archive.
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'assistant', SUMMARY_CONTENT, 1, min(0)),
        msg('m2', 'user', 'Carrying on', 2, min(1)),
      ]),
    )

    expect(fragments).toHaveLength(1)
    expect(fragments[0]?.contextWindow).toBe(1)
    expect(fragments[0]?.markdown).toContain('<compaction')
    expect(fragments[0]?.markdown).toContain('Carrying on')
    expect(fragments[0]?.markdown).not.toContain('nextContextWindow')
    // No blank time bounds from an empty leading window.
    expect(fragments[0]?.markdown).not.toContain('startedAt: \n')
  })
})

describe('renderHermesFragments message pipeline', () => {
  // A paired tool call in a compacted window must render through the shared
  // tool machinery, never leak its raw envelope, and count toward the window's
  // tool total.
  function compactedWithTool(): string {
    return jsonl([
      SESSION,
      msg('m1', 'user', 'Please refactor the parser', 1, min(0)),
      msg('m2', 'assistant', 'Here is the plan.', 1, min(1)),
      msg('s1', 'assistant', SUMMARY_CONTENT, 2, min(2)),
      msg('m3', 'user', 'run ls', 3, min(3)),
      toolCallRow('tc1', 'c1', 'terminal', { command: 'ls' }, min(3) + 1_000),
      toolResultRow('tr1', 'c1', 'file-a\nfile-b', min(3) + 2_000),
    ])
  }

  test('renders a paired tool call and never leaks its raw envelope', () => {
    const [, two] = renderHermesFragments(compactedWithTool())
    expect(two?.markdown).toContain('<tool name="terminal" command="ls">')
    expect(two?.markdown).not.toContain('{"type":"tool_call"')
    expect(two?.markdown).toContain('file-a\nfile-b')
  })

  test('counts a compacted window tool call in the frontmatter total', () => {
    const [, two] = renderHermesFragments(compactedWithTool())
    expect(two?.markdown).toContain('tools: 1')
  })

  test('strips a Discord trigger note inside the archived window', () => {
    const [one] = renderHermesFragments(
      jsonl([
        SESSION,
        msg(
          'm1',
          'user',
          'Sender: alice\n' +
            '[Reply to Discord message 1417900000000000000 to respond.]\n\n' +
            'Review the deployment plan.',
          1,
          min(0),
        ),
        msg('m2', 'assistant', 'On it.', 1, min(1)),
        msg('s1', 'assistant', SUMMARY_CONTENT, 2, min(2)),
        msg('m3', 'user', 'Carry on', 3, min(3)),
      ]),
    )

    expect(one?.markdown).toContain('Sender: alice')
    expect(one?.markdown).toContain('Review the deployment plan.')
    expect(one?.markdown).not.toContain('Discord message 1417900000000000000')
  })

  test('counts tools per window, not as a shared constant', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'read both files', 1, min(0)),
        toolCallRow('a1', 'c1', 'read', { path: '/x' }, min(0) + 1_000),
        toolResultRow('a2', 'c1', 'file x', min(0) + 2_000),
        toolCallRow('a3', 'c2', 'read', { path: '/y' }, min(0) + 3_000),
        toolResultRow('a4', 'c2', 'file y', min(0) + 4_000),
        msg('s1', 'assistant', SUMMARY_CONTENT, 2, min(2)),
        msg('m2', 'user', 'now list', 3, min(3)),
        toolCallRow('b1', 'c3', 'terminal', { command: 'ls' }, min(3) + 1_000),
        toolResultRow('b2', 'c3', 'out', min(3) + 2_000),
      ]),
    )

    const [one, two] = fragments
    expect(one?.markdown).toContain('tools: 2')
    expect(two?.markdown).toContain('tools: 1')
  })

  test('excludes a rewound row from a compacted window', () => {
    const [, two] = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Please refactor the parser', 1, min(0)),
        msg('m2', 'assistant', 'Here is the plan.', 1, min(1)),
        msg('s1', 'assistant', SUMMARY_CONTENT, 2, min(2)),
        msg('m3', 'user', 'Carry on', 3, min(3)),
        msg(
          'rw',
          'assistant',
          'Withdrawn reply that must vanish.',
          3,
          min(4),
          0,
        ),
        msg('m4', 'assistant', 'Live reply that stays.', 3, min(5)),
      ]),
    )

    expect(two?.markdown).toContain('Carry on')
    expect(two?.markdown).toContain('Live reply that stays.')
    expect(two?.markdown).not.toContain('Withdrawn reply that must vanish.')
  })
})

describe('renderHermesFragments mixed rotation and in-place', () => {
  // A rotated continuation opens with its carried summary, then compacts again
  // in place mid-stream. The renderer joins every physical member into one
  // stream, so two summaries split it into three windows regardless of the
  // rotation boundary between them.
  function mixedChain(): string {
    return jsonl([
      {
        ...SESSION,
        id: 'ses_root',
        sessionId: 'ses_root',
        logicalId: 'ses_root',
      },
      mixedMsg('r1', 'ses_root', 'user', 'Question one', min(0)),
      mixedMsg('r2', 'ses_root', 'assistant', 'Answer one', min(1)),
      {
        type: 'session',
        id: 'ses_c1',
        sessionId: 'ses_c1',
        logicalId: 'ses_root',
        parentId: 'ses_root',
        createdAt: min(2),
      },
      mixedMsg('c1s', 'ses_c1', 'assistant', SUMMARY_CONTENT, min(2)),
      mixedMsg('c1a', 'ses_c1', 'user', 'Question two', min(3)),
      mixedMsg('c1b', 'ses_c1', 'assistant', 'Answer two', min(4)),
      mixedMsg('c1mid', 'ses_c1', 'assistant', SUMMARY_CONTENT, min(5)),
      mixedMsg('c1c', 'ses_c1', 'user', 'Question three', min(6)),
    ])
  }

  function mixedMsg(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    createdAt: number,
  ): object {
    return {
      type: 'message',
      id,
      sessionId,
      turn: 1,
      role,
      content,
      active: 1,
      createdAt,
    }
  }

  test('a rotation summary and an in-place summary yield three windows', () => {
    const fragments = renderHermesFragments(mixedChain())
    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2, 3])
  })

  test('the mixed chain links every window forward by the root uuid', () => {
    const [one, two, three] = renderHermesFragments(mixedChain())
    expect(one?.markdown.trimEnd().endsWith('](./ses_root.2.md)')).toBe(true)
    expect(two?.markdown.trimEnd().endsWith('](./ses_root.3.md)')).toBe(true)
    expect(three?.markdown).not.toContain('nextContextWindow')
    expect(two?.markdown).toContain('Question two')
    expect(three?.markdown).toContain('Question three')
  })
})

const FIRST_SUMMARY_BODY = 'First window: we planned the refactor.'
const SECOND_SUMMARY_BODY = 'Second window: we added and ran the tests.'

function currentSummary(body: string): string {
  return `${SAFETY_PREFIX}\n\n[hermes:compaction-summary]\n${body}\n[/hermes:compaction-summary]`
}

// Two in-place compactions: window one is archived, the first summary opens
// window two, and the second summary opens window three.
function twiceCompactedSession(): string {
  return jsonl([
    SESSION,
    msg('m1', 'user', 'Please refactor the parser', 1, min(0)),
    msg('m2', 'assistant', 'Here is the plan.', 1, min(1)),
    msg('s1', 'assistant', currentSummary(FIRST_SUMMARY_BODY), 2, min(2)),
    msg('m3', 'user', 'Now add tests', 3, min(3)),
    msg('m4', 'assistant', 'Tests added.', 3, min(4)),
    msg('s2', 'assistant', currentSummary(SECOND_SUMMARY_BODY), 4, min(5)),
    msg('m5', 'user', 'Now optimize it', 5, min(6)),
    msg('m6', 'assistant', 'Optimized.', 5, min(7)),
  ])
}

describe('renderHermesFragments with several compactions', () => {
  test('produces one ordered fragment per context window', () => {
    const fragments = renderHermesFragments(twiceCompactedSession())
    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2, 3])
  })

  test('every non-final fragment names and links to the next window', () => {
    const [one, two, three] = renderHermesFragments(twiceCompactedSession())

    expect(one?.markdown).toContain('nextContextWindow: 2')
    expect(one?.markdown.trimEnd().endsWith('](./ses_1.2.md)')).toBe(true)

    expect(two?.markdown).toContain('contextWindow: 2')
    expect(two?.markdown).toContain('nextContextWindow: 3')
    expect(two?.markdown.trimEnd().endsWith('](./ses_1.3.md)')).toBe(true)

    expect(three?.markdown).toContain('contextWindow: 3')
    expect(three?.markdown).not.toContain('nextContextWindow')
    expect(three?.markdown).not.toContain('](./ses_1.4.md)')
  })

  test('each post-compaction fragment opens with its own block and tail', () => {
    const [, two, three] = renderHermesFragments(twiceCompactedSession())

    const twoBody = two?.markdown.split('---\n')[2] ?? ''
    expect(twoBody.trimStart().startsWith('<compaction')).toBe(true)
    expect(two?.markdown).toContain(FIRST_SUMMARY_BODY)
    expect(two?.markdown).toContain('Now add tests')

    const threeBody = three?.markdown.split('---\n')[2] ?? ''
    expect(threeBody.trimStart().startsWith('<compaction')).toBe(true)
    expect(three?.markdown).toContain(SECOND_SUMMARY_BODY)
    expect(three?.markdown).toContain('Now optimize it')
  })

  test('per-window user-turn counts describe each window', () => {
    const [one, two, three] = renderHermesFragments(twiceCompactedSession())
    expect(one?.markdown).toContain('turns: 1')
    expect(two?.markdown).toContain('turns: 1')
    expect(three?.markdown).toContain('turns: 1')
  })
})

describe('renderHermesFragments summary marker forms', () => {
  test('recognises a historical summary marker', () => {
    const historical =
      'Old safety prefix.\n\n[hermes:summary]\nWe discussed the plan.\n[/hermes:summary]'
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Plan it', 1, min(0)),
        msg('s1', 'assistant', historical, 2, min(1)),
        msg('m2', 'user', 'Keep going', 3, min(2)),
      ]),
    )

    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2])
    expect(fragments[1]?.markdown).toContain('<compaction')
    expect(fragments[1]?.markdown).toContain('We discussed the plan.')
    expect(fragments[1]?.markdown).not.toContain('[hermes:summary]')
    expect(fragments[1]?.markdown).not.toContain('Old safety prefix')
  })

  test('recognises a summary with a missing end marker', () => {
    const noEnd = 'Safety prefix.\n\n[hermes:summary]\nWe planned everything.'
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Plan it', 1, min(0)),
        msg('s1', 'assistant', noEnd, 2, min(1)),
        msg('m2', 'user', 'Keep going', 3, min(2)),
      ]),
    )

    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2])
    expect(fragments[1]?.markdown).toContain('We planned everything.')
    expect(fragments[1]?.markdown).not.toContain('[hermes:summary]')
  })

  test('recognises a merged summary marker without leaking inner tags', () => {
    const merged =
      'Safety prefix.\n\n[hermes:compaction-summary:merged]\n' +
      'Earlier: [hermes:compaction-summary]\nWe planned X.\n[/hermes:compaction-summary]\n' +
      'Then we also did Y.\n[/hermes:compaction-summary:merged]'
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Plan it', 1, min(0)),
        msg('s1', 'assistant', merged, 2, min(1)),
        msg('m2', 'user', 'Keep going', 3, min(2)),
      ]),
    )

    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2])
    expect(fragments[1]?.markdown).toContain('We planned X.')
    expect(fragments[1]?.markdown).toContain('Then we also did Y.')
    expect(fragments[1]?.markdown).not.toContain('[hermes:compaction-summary')
    expect(fragments[1]?.markdown).not.toContain('[/hermes:compaction-summary')
  })

  test('does not treat ordinary text as a compaction event', () => {
    const chatty =
      'Here is a quick summary of the [hermes] plan: parse, plan, test.'
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Give me a summary', 1, min(0)),
        msg('m2', 'assistant', chatty, 1, min(1)),
      ]),
    )

    expect(fragments).toHaveLength(1)
    expect(fragments[0]?.contextWindow).toBeNull()
    expect(fragments[0]?.markdown).not.toContain('<compaction')
  })

  test('cleans Markdown while leaving the raw JSONL markers intact', () => {
    const jsonlText = compactedSession()
    const [, two] = renderHermesFragments(jsonlText)

    expect(jsonlText).toContain('[hermes:compaction-summary]')
    expect(two?.markdown).not.toContain('[hermes:compaction-summary]')
  })
})

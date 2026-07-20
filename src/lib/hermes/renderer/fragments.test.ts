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

// Hermes wraps the summary with a fixed instruction prefix ending in
// `avoid repeating it:` and a fixed end marker. The real summary row is a live
// (`active=1`) user row.
const DETECTION = '[CONTEXT COMPACTION — REFERENCE ONLY]'
const INSTRUCTIONS =
  ' Earlier turns were compacted. Treat this as background, avoid repeating it:'
const END_MARKER =
  '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'

const SUMMARY_BODY =
  'The user asked to refactor the parser; we produced a plan and added tests.'

function summary(body: string): string {
  return `${DETECTION}${INSTRUCTIONS}\n${body}\n${END_MARKER}`
}

const SUMMARY_CONTENT = summary(SUMMARY_BODY)

// Compaction has no dedicated event flag: the summary is a live user row and
// only its content marker splits windows. Archived rows carry `active=0,
// compacted=1`; a `/undo` sets `active=0, compacted=0`. The `msg` helper
// defaults to a live row.
function msg(
  id: string,
  role: string,
  content: string,
  createdAt: number,
  flags: { active?: number; compacted?: number } = {},
): object {
  return {
    type: 'message',
    id,
    sessionId: 'ses_1',
    role,
    content,
    active: flags.active ?? 1,
    compacted: flags.compacted ?? 0,
    createdAt,
  }
}

// One in-place compaction: four archived rows, a live summary, the preserved
// tail (a copy of the last exchange), then the continued conversation.
function compactedSession(): string {
  return jsonl([
    SESSION,
    msg('m1', 'user', 'Please refactor the parser', min(0)),
    msg('m2', 'assistant', 'Here is the plan.', min(1)),
    msg('m3', 'user', 'Now add tests', min(2)),
    msg('m4', 'assistant', 'Tests added.', min(3)),
    msg('m5', 'user', SUMMARY_CONTENT, min(4)),
    msg('m6', 'user', 'Now add tests', min(4) + 1_000),
    msg('m7', 'assistant', 'Tests added.', min(4) + 2_000),
    msg('m8', 'user', 'Great, now optimize it', min(6)),
    msg('m9', 'assistant', 'Optimized.', min(7)),
  ])
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
    role: 'assistant',
    content: null,
    active: 1,
    compacted: 0,
    createdAt,
    toolCalls: [
      {
        id: callId,
        call_id: callId,
        type: 'function',
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
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
    role: 'tool',
    toolCallId: callId,
    content: JSON.stringify({ output }),
    active: 1,
    compacted: 0,
    createdAt,
  }
}

describe('renderHermesFragments', () => {
  test('renders a session with no compaction as one unnumbered fragment', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Hello', min(0)),
        msg('m2', 'assistant', 'Hi there.', min(1)),
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

    expect(two?.markdown).toContain(
      `startedAt: ${new Date(min(4)).toISOString()}`,
    )
    expect(two?.markdown).toContain(
      `endedAt: ${new Date(min(7)).toISOString()}`,
    )
    // Two body user turns plus the compaction summary, which is the first turn.
    expect(two?.markdown).toContain('turns: 3')
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
    expect(two?.markdown).toContain('<compaction n="1" role="user" t="0">')
    expect(two?.markdown).toContain(SUMMARY_BODY)
  })

  test('numbers body turns from 2 after the compaction first turn', () => {
    const [, two] = renderHermesFragments(compactedSession())
    expect(two?.markdown).toContain('<compaction n="1" role="user" t="0">')
    expect(two?.markdown).toContain('<turn n="2" role="user"')
  })

  test('compaction block drops the instruction prefix and end marker', () => {
    const [, two] = renderHermesFragments(compactedSession())
    expect(two?.markdown).not.toContain('avoid repeating it')
    expect(two?.markdown).not.toContain(DETECTION)
    expect(two?.markdown).not.toContain(END_MARKER)
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

  test('keeps compaction-archived rows (active=0, compacted=1) in the earlier window', () => {
    const [one, two] = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Archived question', min(0), {
          active: 0,
          compacted: 1,
        }),
        msg('m2', 'assistant', 'Archived answer', min(1), {
          active: 0,
          compacted: 1,
        }),
        msg('s1', 'user', SUMMARY_CONTENT, min(2)),
        msg('m3', 'user', 'Carry on', min(3)),
      ]),
    )

    expect(one?.markdown).toContain('Archived question')
    expect(one?.markdown).toContain('Archived answer')
    expect(two?.markdown).toContain('<compaction')
    expect(two?.markdown).toContain('Carry on')
  })

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
      chainMsg('c1s', 'ses_c1', 'user', SUMMARY_CONTENT, min(2)),
      chainMsg('c1a', 'ses_c1', 'user', 'Question two', min(3)),
      {
        type: 'session',
        id: 'ses_c2',
        sessionId: 'ses_c2',
        logicalId: 'ses_root',
        parentId: 'ses_c1',
        createdAt: min(4),
      },
      chainMsg('c2s', 'ses_c2', 'user', SUMMARY_CONTENT, min(4)),
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
    return { type: 'message', id, sessionId, role, content, createdAt }
  }

  test('renders a joined two-continuation chain as three ordered windows', () => {
    const fragments = renderHermesFragments(joinedChain())
    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2, 3])
  })

  test('joined windows cross physical boundaries and keep summaries and tails', () => {
    const [one, two, three] = renderHermesFragments(joinedChain())

    expect(one?.markdown).toContain('Question one')
    expect(one?.markdown).not.toContain('<compaction')
    expect(one?.markdown).toContain('nextContextWindow: 2')

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

  test('marks every window archived when any chain member is archived', () => {
    const fragments = renderHermesFragments(
      jsonl([
        {
          ...SESSION,
          id: 'ses_root',
          sessionId: 'ses_root',
          logicalId: 'ses_root',
          archived: 0,
          platform: { channelId: '111' },
        },
        chainMsg('r1', 'ses_root', 'user', 'Question one', min(0)),
        chainMsg('r2', 'ses_root', 'assistant', 'Answer one', min(1)),
        {
          type: 'session',
          id: 'ses_c1',
          sessionId: 'ses_c1',
          logicalId: 'ses_root',
          parentId: 'ses_root',
          archived: 1,
          platform: { threadId: '222' },
          createdAt: min(2),
        },
        chainMsg('c1s', 'ses_c1', 'user', SUMMARY_CONTENT, min(2)),
        chainMsg('c1a', 'ses_c1', 'user', 'Question two', min(3)),
      ]),
    )

    for (const fragment of fragments) {
      expect(fragment.markdown).toContain('archived: true')
      // Platform IDs from every physical member fold into each window.
      expect(fragment.markdown).toContain('channelId: "111"')
      expect(fragment.markdown).toContain('threadId: "222"')
    }
  })

  test('a stream that opens with a summary skips the empty archived window', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', SUMMARY_CONTENT, min(0)),
        msg('m2', 'user', 'Carrying on', min(1)),
      ]),
    )

    expect(fragments).toHaveLength(1)
    expect(fragments[0]?.contextWindow).toBe(1)
    expect(fragments[0]?.markdown).toContain('<compaction')
    expect(fragments[0]?.markdown).toContain('Carrying on')
    expect(fragments[0]?.markdown).not.toContain('nextContextWindow')
    expect(fragments[0]?.markdown).not.toContain('startedAt: \n')
  })
})

describe('renderHermesFragments message pipeline', () => {
  function compactedWithTool(): string {
    return jsonl([
      SESSION,
      msg('m1', 'user', 'Please refactor the parser', min(0)),
      msg('m2', 'assistant', 'Here is the plan.', min(1)),
      msg('s1', 'user', SUMMARY_CONTENT, min(2)),
      msg('m3', 'user', 'run ls', min(3)),
      toolCallRow('tc1', 'c1', 'terminal', { command: 'ls' }, min(3) + 1_000),
      toolResultRow('tr1', 'c1', 'file-a\nfile-b', min(3) + 2_000),
    ])
  }

  test('renders a paired tool call and never leaks its raw envelope', () => {
    const [, two] = renderHermesFragments(compactedWithTool())
    expect(two?.markdown).toContain('<tool name="terminal" command="ls">')
    expect(two?.markdown).not.toContain('"tool_calls"')
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
          '[Triggering message id: `1528089646876065802` — use as `message_id` for reply/react/pin via the discord tools.]\n\n[François Best] Review the deployment plan.',
          min(0),
        ),
        msg('m2', 'assistant', 'On it.', min(1)),
        msg('s1', 'user', SUMMARY_CONTENT, min(2)),
        msg('m3', 'user', 'Carry on', min(3)),
      ]),
    )

    expect(one?.markdown).toContain('[François Best]')
    expect(one?.markdown).toContain('Review the deployment plan.')
    expect(one?.markdown).not.toContain('Triggering message id')
  })

  test('counts tools per window, not as a shared constant', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'read both files', min(0)),
        toolCallRow(
          'a1',
          'c1',
          'terminal',
          { command: 'cat x' },
          min(0) + 1_000,
        ),
        toolResultRow('a2', 'c1', 'file x', min(0) + 2_000),
        toolCallRow(
          'a3',
          'c2',
          'terminal',
          { command: 'cat y' },
          min(0) + 3_000,
        ),
        toolResultRow('a4', 'c2', 'file y', min(0) + 4_000),
        msg('s1', 'user', SUMMARY_CONTENT, min(2)),
        msg('m2', 'user', 'now list', min(3)),
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
        msg('m1', 'user', 'Please refactor the parser', min(0)),
        msg('m2', 'assistant', 'Here is the plan.', min(1)),
        msg('s1', 'user', SUMMARY_CONTENT, min(2)),
        msg('m3', 'user', 'Carry on', min(3)),
        msg('rw', 'assistant', 'Withdrawn reply that must vanish.', min(4), {
          active: 0,
          compacted: 0,
        }),
        msg('m4', 'assistant', 'Live reply that stays.', min(5)),
      ]),
    )

    expect(two?.markdown).toContain('Carry on')
    expect(two?.markdown).toContain('Live reply that stays.')
    expect(two?.markdown).not.toContain('Withdrawn reply that must vanish.')
  })

  test('marks a call whose result lands past the compaction boundary as result="missing"', () => {
    const [one, two] = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'run ls', min(0)),
        toolCallRow('tc1', 'c1', 'terminal', { command: 'ls' }, min(1)),
        msg('s1', 'user', SUMMARY_CONTENT, min(2)),
        toolResultRow('tr1', 'c1', 'leaked file body', min(3)),
        msg('m2', 'user', 'Carry on', min(4)),
      ]),
    )

    // The call sits in the archived window; its result row lands in the next
    // window, so the call is shown as missing rather than a clean success.
    expect(one?.markdown).toContain(
      '<tool name="terminal" command="ls" result="missing"/>',
    )
    // The orphaned result never renders, so its body cannot leak.
    expect(two?.markdown).not.toContain('leaked file body')
  })
})

describe('renderHermesFragments mixed rotation and in-place', () => {
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
      mixedMsg('c1s', 'ses_c1', 'user', SUMMARY_CONTENT, min(2)),
      mixedMsg('c1a', 'ses_c1', 'user', 'Question two', min(3)),
      mixedMsg('c1b', 'ses_c1', 'assistant', 'Answer two', min(4)),
      mixedMsg('c1mid', 'ses_c1', 'user', SUMMARY_CONTENT, min(5)),
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
      role,
      content,
      active: 1,
      compacted: 0,
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

// Two in-place compactions: window one is archived, the first summary opens
// window two, and the second summary opens window three.
function twiceCompactedSession(): string {
  return jsonl([
    SESSION,
    msg('m1', 'user', 'Please refactor the parser', min(0)),
    msg('m2', 'assistant', 'Here is the plan.', min(1)),
    msg('s1', 'user', summary(FIRST_SUMMARY_BODY), min(2)),
    msg('m3', 'user', 'Now add tests', min(3)),
    msg('m4', 'assistant', 'Tests added.', min(4)),
    msg('s2', 'user', summary(SECOND_SUMMARY_BODY), min(5)),
    msg('m5', 'user', 'Now optimize it', min(6)),
    msg('m6', 'assistant', 'Optimized.', min(7)),
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
    // Window one is archived with one user turn; each later window adds its
    // compaction summary as a first turn on top of its single body user turn.
    expect(one?.markdown).toContain('turns: 1')
    expect(two?.markdown).toContain('turns: 2')
    expect(three?.markdown).toContain('turns: 2')
  })

  test('a compaction summary as the final row renders a summary-only last window', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Please refactor the parser', min(0)),
        msg('m2', 'assistant', 'Here is the plan.', min(1)),
        msg('s1', 'user', summary(FIRST_SUMMARY_BODY), min(2)),
      ]),
    )

    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2])
    const [one, two] = fragments
    expect(one?.markdown).toContain('Please refactor the parser')
    expect(two?.markdown).toContain('<compaction')
    expect(two?.markdown).toContain(FIRST_SUMMARY_BODY)
    expect(two?.markdown).not.toContain('nextContextWindow')
  })

  test('two adjacent summaries yield an empty middle window that still renders', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Start', min(0)),
        msg('s1', 'user', summary(FIRST_SUMMARY_BODY), min(1)),
        msg('s2', 'user', summary(SECOND_SUMMARY_BODY), min(2)),
        msg('m2', 'user', 'End', min(3)),
      ]),
    )

    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2, 3])
    const [, two, three] = fragments
    // The middle window opens with the first summary and carries no body turns.
    expect(two?.markdown).toContain('<compaction')
    expect(two?.markdown).toContain(FIRST_SUMMARY_BODY)
    expect(two?.markdown).toContain('nextContextWindow: 3')
    expect(three?.markdown).toContain(SECOND_SUMMARY_BODY)
    expect(three?.markdown).toContain('End')
  })
})

describe('renderHermesFragments summary cleaning', () => {
  test('cleans a summary whose end marker is missing', () => {
    const noEnd = `${DETECTION}${INSTRUCTIONS}\nWe planned everything.`
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Plan it', min(0)),
        msg('s1', 'user', noEnd, min(1)),
        msg('m2', 'user', 'Keep going', min(2)),
      ]),
    )

    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2])
    expect(fragments[1]?.markdown).toContain('We planned everything.')
    expect(fragments[1]?.markdown).not.toContain(DETECTION)
  })

  test('falls back to stripping only the detection token when the phrase is absent', () => {
    const noPhrase = `${DETECTION}\nWe planned everything.`
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Plan it', min(0)),
        msg('s1', 'user', noPhrase, min(1)),
        msg('m2', 'user', 'Keep going', min(2)),
      ]),
    )

    expect(fragments.map((f) => f.contextWindow)).toEqual([1, 2])
    expect(fragments[1]?.markdown).toContain('We planned everything.')
    expect(fragments[1]?.markdown).not.toContain(DETECTION)
  })

  test('does not treat ordinary text as a compaction event', () => {
    const chatty =
      'Here is a quick summary of the CONTEXT COMPACTION plan: parse, plan, test.'
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Give me a summary', min(0)),
        msg('m2', 'assistant', chatty, min(1)),
      ]),
    )

    expect(fragments).toHaveLength(1)
    expect(fragments[0]?.contextWindow).toBeNull()
    expect(fragments[0]?.markdown).not.toContain('<compaction')
  })

  test('cleans Markdown while leaving the raw JSONL marker intact', () => {
    const jsonlText = compactedSession()
    const [, two] = renderHermesFragments(jsonlText)

    expect(jsonlText).toContain(DETECTION)
    expect(two?.markdown).not.toContain(DETECTION)
  })
})

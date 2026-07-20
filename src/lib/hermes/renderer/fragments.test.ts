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
    msg('m1', 'user', 'Please refactor the parser', 1, 'archived', min(0)),
    msg('m2', 'assistant', 'Here is the plan.', 1, 'archived', min(1)),
    msg('m3', 'user', 'Now add tests', 2, 'archived', min(2)),
    msg('m4', 'assistant', 'Tests added.', 2, 'archived', min(3)),
    msg('m5', 'assistant', SUMMARY_CONTENT, 3, 'active', min(4)),
    msg('m6', 'user', 'Now add tests', 2, 'active', min(4) + 1_000),
    msg('m7', 'assistant', 'Tests added.', 2, 'active', min(4) + 2_000),
    msg('m8', 'user', 'Great, now optimize it', 4, 'active', min(6)),
    msg('m9', 'assistant', 'Optimized.', 4, 'active', min(7)),
  ])
}

function msg(
  id: string,
  role: string,
  content: string,
  turn: number,
  activity: string,
  createdAt: number,
): object {
  return {
    type: 'message',
    id,
    sessionId: 'ses_1',
    turn,
    role,
    content,
    activity,
    createdAt,
  }
}

describe('renderHermesFragments', () => {
  test('renders a session with no compaction as one unnumbered fragment', () => {
    const fragments = renderHermesFragments(
      jsonl([
        SESSION,
        msg('m1', 'user', 'Hello', 1, 'active', min(0)),
        msg('m2', 'assistant', 'Hi there.', 1, 'active', min(1)),
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
    msg('m1', 'user', 'Please refactor the parser', 1, 'archived', min(0)),
    msg('m2', 'assistant', 'Here is the plan.', 1, 'archived', min(1)),
    msg(
      's1',
      'assistant',
      currentSummary(FIRST_SUMMARY_BODY),
      2,
      'archived',
      min(2),
    ),
    msg('m3', 'user', 'Now add tests', 3, 'archived', min(3)),
    msg('m4', 'assistant', 'Tests added.', 3, 'archived', min(4)),
    msg(
      's2',
      'assistant',
      currentSummary(SECOND_SUMMARY_BODY),
      4,
      'active',
      min(5),
    ),
    msg('m5', 'user', 'Now optimize it', 5, 'active', min(6)),
    msg('m6', 'assistant', 'Optimized.', 5, 'active', min(7)),
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
        msg('m1', 'user', 'Plan it', 1, 'archived', min(0)),
        msg('s1', 'assistant', historical, 2, 'active', min(1)),
        msg('m2', 'user', 'Keep going', 3, 'active', min(2)),
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
        msg('m1', 'user', 'Plan it', 1, 'archived', min(0)),
        msg('s1', 'assistant', noEnd, 2, 'active', min(1)),
        msg('m2', 'user', 'Keep going', 3, 'active', min(2)),
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
        msg('m1', 'user', 'Plan it', 1, 'archived', min(0)),
        msg('s1', 'assistant', merged, 2, 'active', min(1)),
        msg('m2', 'user', 'Keep going', 3, 'active', min(2)),
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
        msg('m1', 'user', 'Give me a summary', 1, 'active', min(0)),
        msg('m2', 'assistant', chatty, 1, 'active', min(1)),
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

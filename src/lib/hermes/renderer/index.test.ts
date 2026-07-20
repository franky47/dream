import { describe, expect, test } from 'bun:test'

import { renderHermesSession } from './index.ts'

function jsonl(rows: ReadonlyArray<object>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

const SESSION = {
  type: 'session',
  id: 'ses_1',
  sessionId: 'ses_1',
  source: 'discord',
  title: 'Plan the week',
  createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
  latestMessageTime: Date.UTC(2026, 4, 9, 12, 2, 0),
}

describe('renderHermesSession', () => {
  test('renders frontmatter and both conversation turns', () => {
    const md = renderHermesSession(
      jsonl([
        SESSION,
        {
          type: 'message',
          id: 'msg_1',
          sessionId: 'ses_1',
          turn: 1,
          role: 'user',
          content: 'What should I do?',
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
        },
        {
          type: 'message',
          id: 'msg_2',
          sessionId: 'ses_1',
          turn: 1,
          role: 'assistant',
          content: 'Start with the hardest task.',
          createdAt: Date.UTC(2026, 4, 9, 12, 1, 0),
        },
      ]),
    )

    expect(md).toContain('sessionId: ses_1')
    expect(md).toContain('source: "discord"')
    expect(md).toContain('title: "Plan the week"')
    expect(md).toContain('turns: 1')
    expect(md).toContain('renderer: "hermes-md@1"')
    expect(md).toContain('<turn n="1" role="user" t="0"/>')
    expect(md).toContain('What should I do?')
    expect(md).toContain('<turn n="2" role="assistant" t="+1m00s"/>')
    expect(md).toContain('Start with the hardest task.')
  })

  test('starts a session with an empty conversation cleanly', () => {
    const md = renderHermesSession(jsonl([SESSION]))
    expect(md).toContain('sessionId: ses_1')
    expect(md).toContain('turns: 0')
  })

  test('omits system prompt, model settings and reasoning from Markdown', () => {
    const md = renderHermesSession(
      jsonl([
        {
          ...SESSION,
          systemPrompt: 'You are Hermes, a secret system prompt.',
          model: 'llama-swap/big',
          modelSettings: { temperature: 0.7, maxTokens: 4096 },
        },
        {
          type: 'message',
          id: 'msg_1',
          sessionId: 'ses_1',
          turn: 1,
          role: 'assistant',
          content: 'The answer is 42.',
          reasoning: 'Chain of thought that must stay out of Markdown.',
          createdAt: Date.UTC(2026, 4, 9, 12, 1, 0),
        },
      ]),
    )

    expect(md).toContain('The answer is 42.')
    expect(md).not.toContain('secret system prompt')
    expect(md).not.toContain('Chain of thought')
    expect(md).not.toContain('temperature')
    expect(md).not.toContain('llama-swap/big')
  })

  test('lists all available platform IDs in frontmatter', () => {
    const md = renderHermesSession(
      jsonl([
        {
          ...SESSION,
          platform: {
            channelId: '111',
            threadId: '222',
            guildId: '333',
            authorName: 'Franky',
          },
        },
      ]),
    )

    expect(md).toContain('platform:')
    expect(md).toContain('  authorName: "Franky"')
    expect(md).toContain('  channelId: "111"')
    expect(md).toContain('  guildId: "333"')
    expect(md).toContain('  threadId: "222"')
  })

  test('omits the platform block when no platform data is present', () => {
    const md = renderHermesSession(jsonl([SESSION]))
    expect(md).not.toContain('platform:')
  })

  test('omits rewound user, assistant and tool rows from Markdown', () => {
    const md = renderHermesSession(
      jsonl([
        SESSION,
        {
          type: 'message',
          id: 'msg_live_user',
          sessionId: 'ses_1',
          turn: 1,
          role: 'user',
          content: 'Live question that stays.',
          active: 1,
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
        },
        {
          type: 'message',
          id: 'msg_rewound_user',
          sessionId: 'ses_1',
          turn: 2,
          role: 'user',
          content: 'Withdrawn user request.',
          active: 0,
          createdAt: Date.UTC(2026, 4, 9, 12, 1, 0),
        },
        {
          type: 'message',
          id: 'msg_rewound_assistant',
          sessionId: 'ses_1',
          turn: 2,
          role: 'assistant',
          content: 'Withdrawn assistant reply.',
          active: 0,
          createdAt: Date.UTC(2026, 4, 9, 12, 1, 30),
        },
        {
          type: 'message',
          id: 'msg_rewound_tool',
          sessionId: 'ses_1',
          turn: 2,
          role: 'tool',
          content: 'Withdrawn tool output.',
          active: 0,
          createdAt: Date.UTC(2026, 4, 9, 12, 1, 45),
        },
        {
          type: 'message',
          id: 'msg_live_assistant',
          sessionId: 'ses_1',
          turn: 1,
          role: 'assistant',
          content: 'Live answer that stays.',
          active: 1,
          createdAt: Date.UTC(2026, 4, 9, 12, 2, 0),
        },
      ]),
    )

    expect(md).toContain('Live question that stays.')
    expect(md).toContain('Live answer that stays.')
    expect(md).not.toContain('Withdrawn user request.')
    expect(md).not.toContain('Withdrawn assistant reply.')
    expect(md).not.toContain('Withdrawn tool output.')
  })

  test('rewound rows do not skew turns or time bounds', () => {
    const withRewound = renderHermesSession(
      jsonl([
        SESSION,
        {
          type: 'message',
          id: 'msg_live_user',
          sessionId: 'ses_1',
          turn: 1,
          role: 'user',
          content: 'Live question.',
          active: 1,
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
        },
        {
          type: 'message',
          id: 'msg_rewound_user',
          sessionId: 'ses_1',
          turn: 2,
          role: 'user',
          content: 'Withdrawn user request.',
          active: 0,
          createdAt: Date.UTC(2026, 4, 9, 13, 0, 0),
        },
        {
          type: 'message',
          id: 'msg_live_assistant',
          sessionId: 'ses_1',
          turn: 1,
          role: 'assistant',
          content: 'Live answer.',
          active: 1,
          createdAt: Date.UTC(2026, 4, 9, 12, 1, 0),
        },
      ]),
    )

    // One rewound user turn at 13:00 would inflate the count to 2 and push the
    // end bound out an hour if it leaked into the rendered view.
    expect(withRewound).toContain('turns: 1')
    expect(withRewound).toContain('endedAt: 2026-05-09T12:01:00.000Z')
    expect(withRewound).not.toContain('Withdrawn user request.')
  })

  test('drops rewound rows around a compaction summary while the summary stays', () => {
    const md = renderHermesSession(
      jsonl([
        SESSION,
        {
          type: 'message',
          id: 'msg_rewound_before',
          sessionId: 'ses_1',
          turn: 1,
          role: 'user',
          content: 'Withdrawn before compaction.',
          active: 0,
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
        },
        {
          type: 'message',
          id: 'msg_summary',
          sessionId: 'ses_1',
          turn: 2,
          role: 'user',
          content: 'Compaction summary that Hermes sent to the model.',
          active: 1,
          createdAt: Date.UTC(2026, 4, 9, 12, 1, 0),
        },
        {
          type: 'message',
          id: 'msg_rewound_after',
          sessionId: 'ses_1',
          turn: 3,
          role: 'assistant',
          content: 'Withdrawn after compaction.',
          active: 0,
          createdAt: Date.UTC(2026, 4, 9, 12, 2, 0),
        },
        {
          type: 'message',
          id: 'msg_live_after',
          sessionId: 'ses_1',
          turn: 3,
          role: 'assistant',
          content: 'Live reply after compaction.',
          active: 1,
          createdAt: Date.UTC(2026, 4, 9, 12, 3, 0),
        },
      ]),
    )

    expect(md).toContain('Compaction summary that Hermes sent to the model.')
    expect(md).toContain('Live reply after compaction.')
    expect(md).not.toContain('Withdrawn before compaction.')
    expect(md).not.toContain('Withdrawn after compaction.')
  })

  test('keeps the rest of the frontmatter when platform is not an object', () => {
    const md = renderHermesSession(jsonl([{ ...SESSION, platform: 'discord' }]))
    expect(md).toContain('sessionId: ses_1')
    expect(md).toContain('title: "Plan the week"')
    expect(md).not.toContain('platform:')
  })
})

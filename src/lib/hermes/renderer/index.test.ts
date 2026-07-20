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

  test('strips the Discord trigger note from user text but keeps context', () => {
    const md = renderHermesSession(
      jsonl([
        SESSION,
        {
          type: 'message',
          id: 'msg_1',
          sessionId: 'ses_1',
          turn: 1,
          role: 'user',
          content:
            'Sender: alice\n[Reply to Discord message 1417900000000000000 to respond.]\n\nWhat should I do?',
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
        },
      ]),
    )

    expect(md).toContain('Sender: alice')
    expect(md).toContain('What should I do?')
    expect(md).not.toContain('Discord message 1417900000000000000')
  })
})

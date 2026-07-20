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

  test('keeps the rest of the frontmatter when platform is not an object', () => {
    const md = renderHermesSession(jsonl([{ ...SESSION, platform: 'discord' }]))
    expect(md).toContain('sessionId: ses_1')
    expect(md).toContain('title: "Plan the week"')
    expect(md).not.toContain('platform:')
  })

  test('marks an archived session with archived: true', () => {
    const md = renderHermesSession(jsonl([{ ...SESSION, archived: 1 }]))
    expect(md).toContain('archived: true')
  })

  test('omits the archived field on a live session', () => {
    const md = renderHermesSession(jsonl([{ ...SESSION, archived: 0 }]))
    expect(md).not.toContain('archived:')
  })

  test('omits the archived field when the flag is absent', () => {
    const md = renderHermesSession(jsonl([SESSION]))
    expect(md).not.toContain('archived:')
  })

  test('renders a paired tool call with its bespoke shape', () => {
    const md = renderHermesSession(
      jsonl([
        SESSION,
        {
          type: 'message',
          id: 'msg_1',
          sessionId: 'ses_1',
          turn: 1,
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_call',
            callId: 'c1',
            name: 'terminal',
            input: { command: 'ls' },
          }),
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
        },
        {
          type: 'message',
          id: 'msg_2',
          sessionId: 'ses_1',
          turn: 1,
          role: 'tool',
          content: JSON.stringify({
            type: 'tool_result',
            callId: 'c1',
            output: 'a\nb',
          }),
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 30),
        },
      ]),
    )

    expect(md).toContain('<tool name="terminal" command="ls">')
    expect(md).toContain('a\nb')
  })

  test('renders an unknown tool through the compact fallback', () => {
    const md = renderHermesSession(
      jsonl([
        SESSION,
        {
          type: 'message',
          id: 'msg_1',
          sessionId: 'ses_1',
          turn: 1,
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_call',
            callId: 'c1',
            name: 'browser',
            input: { url: 'https://example.com' },
          }),
          createdAt: Date.UTC(2026, 4, 9, 12, 0, 0),
        },
      ]),
    )

    expect(md).toContain('<tool name="browser" url="https://example.com"/>')
  })
})

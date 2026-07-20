import { describe, expect, test } from 'bun:test'

import { stripDiscordTriggerNote } from './discord.ts'

describe('stripDiscordTriggerNote', () => {
  test('removes the fixed triggering-message note', () => {
    const cleaned = stripDiscordTriggerNote(
      '[Reply to Discord message 1417900000000000000 to respond.]\n\nCan you review the plan?',
    )
    expect(cleaned).toBe('Can you review the plan?')
    expect(cleaned).not.toContain('Discord message')
  })

  test('keeps the sender-name prefix', () => {
    const cleaned = stripDiscordTriggerNote(
      'Sender: alice\n[Reply to Discord message 1417900000000000000 to respond.]\n\nhi there',
    )
    expect(cleaned).toContain('Sender: alice')
    expect(cleaned).toContain('hi there')
    expect(cleaned).not.toContain('Discord message')
  })

  test('keeps reply context', () => {
    const cleaned = stripDiscordTriggerNote(
      'In reply to bob: "ship it tomorrow"\n[Reply to Discord message 1417900000000000000 to respond.]\n\nsounds good',
    )
    expect(cleaned).toContain('In reply to bob: "ship it tomorrow"')
    expect(cleaned).toContain('sounds good')
    expect(cleaned).not.toContain('to respond')
  })

  test('keeps attachment and document context', () => {
    const cleaned = stripDiscordTriggerNote(
      'Attachment: diagram.pdf (application/pdf)\n[Reply to Discord message 1417900000000000000 to respond.]\n\nsee the doc',
    )
    expect(cleaned).toContain('Attachment: diagram.pdf (application/pdf)')
    expect(cleaned).toContain('see the doc')
    expect(cleaned).not.toContain('Discord message')
  })

  test('keeps every retained note when the prefixes are combined', () => {
    const cleaned = stripDiscordTriggerNote(
      [
        'Sender: alice',
        'In reply to bob: "ship it tomorrow"',
        'Attachment: diagram.pdf (application/pdf)',
        '[Reply to Discord message 1417900000000000000 to respond.]',
        '',
        'Can you review the deployment plan?',
      ].join('\n'),
    )
    expect(cleaned).toBe(
      [
        'Sender: alice',
        'In reply to bob: "ship it tomorrow"',
        'Attachment: diagram.pdf (application/pdf)',
        '',
        'Can you review the deployment plan?',
      ].join('\n'),
    )
  })

  test('preserves multiline user text and its blank lines', () => {
    const body = 'First paragraph.\n\nSecond paragraph.\n  indented line'
    const cleaned = stripDiscordTriggerNote(
      `[Reply to Discord message 1417900000000000000 to respond.]\n\n${body}`,
    )
    expect(cleaned).toBe(body)
  })

  test('leaves ordinary text untouched, byte for byte', () => {
    const ordinary =
      'Can you look up the Discord message about the release ID we discussed?'
    expect(stripDiscordTriggerNote(ordinary)).toBe(ordinary)
  })

  test('does not remove a bracketed line that is not the fixed note', () => {
    const text = '[TODO] wire up the Discord message 42 handler'
    expect(stripDiscordTriggerNote(text)).toBe(text)
  })

  test('does not remove a reply-context line that mentions a message id', () => {
    const text = 'In reply to a Discord message 1417900000000000000 earlier'
    expect(stripDiscordTriggerNote(text)).toBe(text)
  })

  test('returns an empty string when the note is the only content', () => {
    expect(
      stripDiscordTriggerNote(
        '[Reply to Discord message 1417900000000000000 to respond.]',
      ),
    ).toBe('')
  })
})

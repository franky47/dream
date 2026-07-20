import { describe, expect, test } from 'bun:test'

import { stripDiscordTriggerNote } from './discord.ts'

const TRIGGER =
  '[Triggering message id: `1528089646876065802` — use as `message_id` ' +
  'for reply/react/pin via the discord tools.]'

describe('stripDiscordTriggerNote', () => {
  test('removes the triggering-message note but keeps the sender prefix', () => {
    const cleaned = stripDiscordTriggerNote(
      `${TRIGGER}\n\n[François Best] hey buddy, are you up?`,
    )
    expect(cleaned).toBe('[François Best] hey buddy, are you up?')
    expect(cleaned).not.toContain('Triggering message id')
  })

  test('keeps the [Name] sender prefix on its own', () => {
    const cleaned = stripDiscordTriggerNote(
      `${TRIGGER}\n[François Best] hi there`,
    )
    expect(cleaned).toContain('[François Best]')
    expect(cleaned).toContain('hi there')
    expect(cleaned).not.toContain('discord tools')
  })

  test('preserves multiline user text and its blank lines', () => {
    const body =
      '[Alice] First paragraph.\n\nSecond paragraph.\n  indented line'
    const cleaned = stripDiscordTriggerNote(`${TRIGGER}\n\n${body}`)
    expect(cleaned).toBe(body)
  })

  test('leaves ordinary text untouched, byte for byte', () => {
    const ordinary =
      'Can you look up the Discord message about the release id we discussed?'
    expect(stripDiscordTriggerNote(ordinary)).toBe(ordinary)
  })

  test('does not remove a bracketed line that is not the trigger note', () => {
    const text = '[TODO] wire up the discord tools handler for message 42'
    expect(stripDiscordTriggerNote(text)).toBe(text)
  })

  test('returns an empty string when the note is the only content', () => {
    expect(stripDiscordTriggerNote(TRIGGER)).toBe('')
  })

  test('keeps a note quoted later in the body, stripping only the leading one', () => {
    const body = `[François Best] Here is the raw note I received:\n${TRIGGER}\nWhat does it mean?`
    const cleaned = stripDiscordTriggerNote(`${TRIGGER}\n\n${body}`)
    expect(cleaned).toBe(body)
    expect(cleaned).toContain('Triggering message id')
  })

  test('strips several leading notes but no later occurrence', () => {
    const cleaned = stripDiscordTriggerNote(
      `${TRIGGER}\n${TRIGGER}\n\n[Alice] hello`,
    )
    expect(cleaned).toBe('[Alice] hello')
  })
})

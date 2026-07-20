// Hermes frames a Discord-triggered user message by prepending a fixed control
// note to the raw text it stores. The stored content looks like:
//
//   [Triggering message id: `1528089646876065802` — use as `message_id` for
//   reply/react/pin via the discord tools.]
//
//   [François Best] hey buddy, are you up?
//
// The bracketed line is internal tool guidance: it tells Hermes' Discord tools
// which message to reply to, react to, or pin. Only the snowflake id varies; the
// wording is constant. It is not part of the human's message, so it is stripped
// from the readable view. The `[Name]` sender prefix and the message body stay.
// The raw JSONL keeps the stored content untouched.
//
// The pattern below is the single source of truth for that note. It tolerates
// the backticks Hermes wraps around the id and the em dash in the wording.
const DISCORD_TRIGGER_NOTE =
  /^\[triggering message id:.*\d{17,20}.*discord tools\.?\]$/i

function isTriggerNote(line: string): boolean {
  return DISCORD_TRIGGER_NOTE.test(line.trim())
}

function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start += 1
  while (end > start && lines[end - 1]?.trim() === '') end -= 1
  return lines.slice(start, end)
}

// Hermes prepends the note as the leading framing of the stored text, so only a
// leading run of notes (and the blank lines around them) is framing. A note that
// appears later is quoted content the human typed, so it stays untouched.
export function stripDiscordTriggerNote(content: string): string {
  const lines = content.split('\n')
  let start = 0
  let removed = false
  while (start < lines.length) {
    const line = lines[start]!
    if (isTriggerNote(line)) {
      removed = true
      start += 1
      continue
    }
    if (line.trim() === '') {
      start += 1
      continue
    }
    break
  }
  if (!removed) return content
  return trimBlankEdges(lines.slice(start)).join('\n')
}

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

export function stripDiscordTriggerNote(content: string): string {
  const lines = content.split('\n')
  const kept = lines.filter((line) => !isTriggerNote(line))
  if (kept.length === lines.length) return content
  return trimBlankEdges(kept).join('\n')
}

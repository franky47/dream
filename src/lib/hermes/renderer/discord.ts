// Hermes frames a Discord-triggered user message by prepending platform-context
// notes to the raw text it stores. Most of that framing helps a reader follow
// the exchange and stays in the rendered Markdown:
//
//   Sender: alice
//   In reply to bob: "let's ship tomorrow"
//   Attachment: diagram.pdf (application/pdf)
//   [Reply to Discord message 1417900000000000000 to respond.]
//
//   Can you review the deployment plan before we ship?
//
// The bracketed line is different: it is a fixed instruction Hermes injects so
// its Discord reply tool knows which message to answer. Only the snowflake ID
// varies; the wording is constant. It is internal tool guidance, not part of the
// human's message, so it is stripped from the readable view. The raw JSONL keeps
// the stored content untouched.
//
// The pattern below is the single source of truth for that note. Sender, reply
// and attachment notes use different wording and are deliberately left in place.
const DISCORD_TRIGGER_NOTE =
  /^\[reply to discord message \d{17,20}(?: to respond\.?)?\]$/i

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

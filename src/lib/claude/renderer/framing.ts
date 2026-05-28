const FRAMING_TAGS = [
  'system-reminder',
  'command-message',
  'local-command-stdout',
] as const

const SLASH_COMMAND_ONLY_RE =
  /^\s*<command-name>([\s\S]*?)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?\s*$/

export function stripFraming(text: string): string {
  let out = text
  for (const tag of FRAMING_TAGS) {
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'g')
    out = out.replace(re, '')
  }
  const slashOnly = out.match(SLASH_COMMAND_ONLY_RE)
  if (slashOnly !== null) {
    const name = (slashOnly[1] ?? '').trim()
    const args = (slashOnly[2] ?? '').trim()
    return `[${name} args="${args}"]`
  }
  out = out.replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
  out = out.replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
  return out.replace(/\s+/g, ' ').trim()
}

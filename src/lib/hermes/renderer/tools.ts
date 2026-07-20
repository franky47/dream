import type { ToolPart, ToolRenderer } from '#lib/renderer/types'

function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\t', '&#9;')
}

function renderInputAttrs(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') parts.push(`${k}="${escapeAttr(v)}"`)
    else if (typeof v === 'number' || typeof v === 'boolean')
      parts.push(`${k}="${String(v)}"`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

export const hermesFallback: ToolRenderer<void> = (tool: ToolPart): string => {
  const attrs = renderInputAttrs(tool.input)
  const errorAttr = tool.result?.isError === true ? ' error="1"' : ''
  return `<tool name="${escapeAttr(tool.name)}"${attrs}${errorAttr}/>`
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function errorAttr(tool: ToolPart): string {
  return tool.result?.isError === true ? ' error="1"' : ''
}

function attr(name: string, value: string): string {
  return value.length === 0 ? '' : ` ${name}="${escapeAttr(value)}"`
}

function blockOrSelfClosing(head: string, body: string): string {
  if (body.length === 0) return `${head}/>`
  return `${head}>\n${body}\n</tool>`
}

// The `terminal` tool runs a shell command; Hermes stores its input as
// `{command, workdir, timeout}` and its result as the command output. The
// renderer shows the command and workdir, then the output body.
const renderTerminal: ToolRenderer<void> = (tool) => {
  const command = asString(tool.input.command)
  const workdir = attr('workdir', asString(tool.input.workdir))
  const head = `<tool name="terminal"${attr(
    'command',
    command,
  )}${workdir}${errorAttr(tool)}`
  const body = tool.result === undefined ? '' : tool.result.content
  return blockOrSelfClosing(head, body)
}

// `skill_view` loads a skill document into the session; its input is
// `{name, file_path?}`. The result is the full skill body, far too large to
// inline, so the renderer keeps only which skill (and file) was viewed.
const renderSkillView: ToolRenderer<void> = (tool) => {
  const name = attr('skill', asString(tool.input.name))
  const file = attr('file', asString(tool.input.file_path))
  return `<tool name="skill_view"${name}${file}${errorAttr(tool)}/>`
}

export const hermesTools: Record<string, ToolRenderer<void>> = {
  terminal: renderTerminal,
  skill_view: renderSkillView,
}

import type { ToolPart, ToolRenderer } from '#lib/renderer/types'

// Bespoke Hermes tool renderers land in a later work unit; the basic session
// path renders every tool through the standard compact fallback.
export const hermesTools: Record<string, ToolRenderer<void>> = {}

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

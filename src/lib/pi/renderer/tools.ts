import { z } from 'zod'

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

export const piFallback: ToolRenderer<void> = (tool: ToolPart): string => {
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

function blockOrSelfClosing(head: string, body: string): string {
  if (body.length === 0) return `${head}/>`
  return `${head}>\n${body}\n</tool>`
}

const renderBash: ToolRenderer<void> = (tool) => {
  const command = asString(tool.input.command)
  const cmdAttr = ` command="${escapeAttr(command)}"`
  const head = `<tool name="bash"${cmdAttr}${errorAttr(tool)}`
  const body = tool.result === undefined ? '' : tool.result.content
  return blockOrSelfClosing(head, body)
}

function numAttr(name: string, v: unknown): string {
  return typeof v === 'number' ? ` ${name}="${String(v)}"` : ''
}

const renderRead: ToolRenderer<void> = (tool) => {
  const path = asString(tool.input.path)
  const pathAttr = ` path="${escapeAttr(path)}"`
  const offset = numAttr('offset', tool.input.offset)
  const limit = numAttr('limit', tool.input.limit)
  const head = `<tool name="read"${pathAttr}${offset}${limit}${errorAttr(tool)}`
  const body = tool.result === undefined ? '' : tool.result.content
  return blockOrSelfClosing(head, body)
}

const editDetailsSchema = z.object({ diff: z.string() })
const editItemSchema = z.object({
  oldText: z.string().optional(),
  newText: z.string().optional(),
})
const editItemsSchema = z.array(editItemSchema)

function diffFromDetails(details: unknown): string | null {
  const parsed = editDetailsSchema.safeParse(details)
  return parsed.success ? parsed.data.diff : null
}

function diffFromEdits(edits: unknown): string {
  const parsed = editItemsSchema.safeParse(edits)
  if (!parsed.success) return ''
  const lines: string[] = []
  for (const item of parsed.data) {
    if (item.oldText !== undefined) lines.push(`- ${item.oldText}`)
    if (item.newText !== undefined) lines.push(`+ ${item.newText}`)
  }
  return lines.join('\n')
}

const renderEdit: ToolRenderer<void> = (tool) => {
  const path = asString(tool.input.path)
  const pathAttr = ` path="${escapeAttr(path)}"`
  const head = `<tool name="edit"${pathAttr}${errorAttr(tool)}`
  const fromDetails = diffFromDetails(tool.result?.details)
  const body = fromDetails ?? diffFromEdits(tool.input.edits)
  return blockOrSelfClosing(head, body)
}

function countLines(s: string): number {
  if (s.length === 0) return 0
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s
  if (trimmed.length === 0) return 0
  let n = 1
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) === 10) n += 1
  }
  return n
}

const renderWrite: ToolRenderer<void> = (tool) => {
  const path = asString(tool.input.path)
  const content = asString(tool.input.content)
  const lines = countLines(content)
  const bytes = Buffer.byteLength(content, 'utf8')
  const head = `<tool name="write" path="${escapeAttr(path)}" lines="${lines}" bytes="${bytes}"${errorAttr(tool)}`
  const errorBody = tool.result?.isError === true ? tool.result.content : ''
  return blockOrSelfClosing(head, errorBody)
}

export const piTools: Record<string, ToolRenderer<void>> = {
  bash: renderBash,
  read: renderRead,
  edit: renderEdit,
  write: renderWrite,
}

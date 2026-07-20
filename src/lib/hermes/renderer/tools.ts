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
  return ` ${name}="${escapeAttr(value)}"`
}

function numAttr(name: string, v: unknown): string {
  return typeof v === 'number' ? ` ${name}="${String(v)}"` : ''
}

function blockOrSelfClosing(head: string, body: string): string {
  if (body.length === 0) return `${head}/>`
  return `${head}>\n${body}\n</tool>`
}

// Hermes wraps OpenAI Codex and records each turn's tool executions. The
// terminal and patch results carry an execution status alongside their output,
// so both renderers parse that envelope before projecting attributes.
const statusDetailsSchema = z.object({
  exitCode: z.number().optional(),
  status: z.string().optional(),
})

function statusAttrs(details: unknown): string {
  const parsed = statusDetailsSchema.safeParse(details)
  if (!parsed.success) return ''
  const exit =
    parsed.data.exitCode === undefined
      ? ''
      : ` exit="${String(parsed.data.exitCode)}"`
  const status =
    parsed.data.status === undefined ? '' : attr('status', parsed.data.status)
  return `${exit}${status}`
}

const renderTerminal: ToolRenderer<void> = (tool) => {
  const command = asString(tool.input.command)
  const head = `<tool name="terminal"${attr('command', command)}${statusAttrs(
    tool.result?.details,
  )}${errorAttr(tool)}`
  const body = tool.result === undefined ? '' : tool.result.content
  return blockOrSelfClosing(head, body)
}

const renderRead: ToolRenderer<void> = (tool) => {
  const path = asString(tool.input.path)
  const offset = numAttr('offset', tool.input.offset)
  const limit = numAttr('limit', tool.input.limit)
  const head = `<tool name="read"${attr(
    'path',
    path,
  )}${offset}${limit}${errorAttr(tool)}`
  const body = tool.result === undefined ? '' : tool.result.content
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

// Large writes copy their whole payload into the transcript, so the renderer
// keeps file statistics instead of the content and shows only an error body.
const renderWrite: ToolRenderer<void> = (tool) => {
  const path = asString(tool.input.path)
  const content = asString(tool.input.content)
  const lines = countLines(content)
  const bytes = Buffer.byteLength(content, 'utf8')
  const head = `<tool name="write"${attr(
    'path',
    path,
  )} lines="${lines}" bytes="${bytes}"${errorAttr(tool)}`
  const errorBody = tool.result?.isError === true ? tool.result.content : ''
  return blockOrSelfClosing(head, errorBody)
}

function diffFromInput(input: Record<string, unknown>): string {
  const diff = asString(input.diff)
  return diff.length > 0 ? diff : asString(input.patch)
}

const renderPatch: ToolRenderer<void> = (tool) => {
  const path = asString(tool.input.path)
  const pathAttr = path.length > 0 ? attr('path', path) : ''
  const head = `<tool name="patch"${pathAttr}${statusAttrs(
    tool.result?.details,
  )}${errorAttr(tool)}`
  return blockOrSelfClosing(head, diffFromInput(tool.input))
}

const renderSearch: ToolRenderer<void> = (tool) => {
  const query = asString(tool.input.query)
  const path = asString(tool.input.path)
  const pathAttr = path.length > 0 ? attr('path', path) : ''
  const head = `<tool name="search"${attr('query', query)}${pathAttr}${errorAttr(
    tool,
  )}`
  const body = tool.result === undefined ? '' : tool.result.content
  return blockOrSelfClosing(head, body)
}

const todoInputSchema = z.object({
  todos: z.array(
    z.object({ content: z.string(), status: z.string().optional() }),
  ),
})

function todoBody(input: Record<string, unknown>): string {
  const parsed = todoInputSchema.safeParse(input)
  if (!parsed.success) return ''
  return parsed.data.todos
    .map((t) => {
      const mark = t.status === 'completed' ? '[x]' : '[ ]'
      return `- ${mark} ${t.content}`
    })
    .join('\n')
}

const renderTodo: ToolRenderer<void> = (tool) => {
  const head = `<tool name="todo"${errorAttr(tool)}`
  return blockOrSelfClosing(head, todoBody(tool.input))
}

const renderClarify: ToolRenderer<void> = (tool) => {
  const question = asString(tool.input.question)
  const head = `<tool name="clarify"${attr('question', question)}${errorAttr(
    tool,
  )}`
  const body = tool.result === undefined ? '' : tool.result.content
  return blockOrSelfClosing(head, body)
}

export const hermesTools: Record<string, ToolRenderer<void>> = {
  terminal: renderTerminal,
  read: renderRead,
  write: renderWrite,
  patch: renderPatch,
  search: renderSearch,
  todo: renderTodo,
  clarify: renderClarify,
}

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

// Body text sits between tags rather than inside an attribute, so escaping the
// three markup-significant characters is enough to keep hostile content from
// breaking out of the `<tool>` block.
function escapeText(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function attr(name: string, value: string): string {
  return value.length === 0 ? '' : ` ${name}="${escapeAttr(value)}"`
}

function numAttr(name: string, value: unknown): string {
  return typeof value === 'number' ? ` ${name}="${String(value)}"` : ''
}

function errorAttr(tool: ToolPart): string {
  return tool.result?.isError === true ? ' error="1"' : ''
}

// A call whose result never arrived (a paired result dropped at a window
// boundary, or a session that ended before the tool returned) is marked so a
// reader can tell "no output" from "output lost". A resolved call always carries
// a `result`, so this marks only the genuinely unpaired ones.
function missingResultAttr(tool: ToolPart): string {
  return tool.result === undefined ? ' result="missing"' : ''
}

// The trailing status attributes shared by every tool head: an error marker and,
// when a call has no paired result at all, a `result="missing"` marker. The two
// are mutually exclusive — an error implies a result arrived.
function statusAttrs(tool: ToolPart): string {
  return `${missingResultAttr(tool)}${errorAttr(tool)}`
}

function blockOrSelfClosing(head: string, body: string): string {
  if (body.length === 0) return `${head}/>`
  return `${head}>\n${body}\n</tool>`
}

// An XML-safe attribute name: a hostile tool could ship a key like `x"><script>`,
// which must never become a raw attribute name. Only keys matching this pattern
// are emitted as attributes; the rest fold into an escaped body.
const SAFE_ATTR_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  )
}

interface FallbackInputs {
  attrs: string
  unsafe: ReadonlyArray<readonly [string, string]>
}

function collectFallbackInputs(input: Record<string, unknown>): FallbackInputs {
  const attrs: string[] = []
  const unsafe: Array<[string, string]> = []
  for (const [key, value] of Object.entries(input)) {
    if (!isScalar(value)) continue
    const text = String(value)
    if (SAFE_ATTR_NAME.test(key)) attrs.push(`${key}="${escapeAttr(text)}"`)
    else unsafe.push([key, text])
  }
  return { attrs: attrs.length === 0 ? '' : ` ${attrs.join(' ')}`, unsafe }
}

// Unknown tools stay readable through a compact self-closing tag. Scalar inputs
// with safe names become attributes; a hostile key is escaped into the body
// instead of injected as raw markup.
export const hermesFallback: ToolRenderer<void> = (tool: ToolPart): string => {
  const { attrs, unsafe } = collectFallbackInputs(tool.input)
  const head = `<tool name="${escapeAttr(tool.name)}"${attrs}${statusAttrs(tool)}`
  const body = unsafe
    .map(([key, value]) => `${escapeText(key)}: ${escapeText(value)}`)
    .join('\n')
  return blockOrSelfClosing(head, body)
}

const terminalResultSchema = z
  .object({ exit_code: z.number().optional() })
  .loose()

// On a failed run, surface the exit code Hermes recorded so the reader sees why
// the command failed rather than only that it did.
function terminalExitAttr(tool: ToolPart): string {
  if (tool.result?.isError !== true) return ''
  const parsed = terminalResultSchema.safeParse(tool.result.details)
  const code = parsed.success ? parsed.data.exit_code : undefined
  return code === undefined ? '' : ` exit_code="${String(code)}"`
}

// The `terminal` tool runs a shell command; Hermes stores its input as
// `{command, workdir, timeout}` and its result as `{output, exit_code, error}`.
// The renderer shows the command and workdir, then the output body, and marks a
// non-zero exit with the code.
const renderTerminal: ToolRenderer<void> = (tool) => {
  const command = attr('command', asString(tool.input.command))
  const workdir = attr('workdir', asString(tool.input.workdir))
  const head = `<tool name="terminal"${command}${workdir}${terminalExitAttr(
    tool,
  )}${statusAttrs(tool)}`
  // Command output is attacker-influenced (filenames, fetched web text), so
  // escape it: a raw `</tool>` in stdout would otherwise forge later turns.
  const body = tool.result === undefined ? '' : escapeText(tool.result.content)
  return blockOrSelfClosing(head, body)
}

// `skill_view` loads a skill document into the session; its input is
// `{name, file_path?}`. The result is the full skill body, far too large to
// inline, so the renderer keeps only which skill (and file) was viewed.
const renderSkillView: ToolRenderer<void> = (tool) => {
  const name = attr('skill', asString(tool.input.name))
  const file = attr('file', asString(tool.input.file_path))
  return `<tool name="skill_view"${name}${file}${statusAttrs(tool)}/>`
}

// `read_file` reads a slice of a file; its input is `{path, offset?, limit?}` and
// its result is `{content}`. The content can be huge, so the renderer keeps only
// which slice of which file was read.
const renderReadFile: ToolRenderer<void> = (tool) => {
  const path = attr('path', asString(tool.input.path))
  const offset = numAttr('offset', tool.input.offset)
  const limit = numAttr('limit', tool.input.limit)
  return `<tool name="read_file"${path}${offset}${limit}${statusAttrs(tool)}/>`
}

const writeResultSchema = z
  .object({
    bytes_written: z.number().optional(),
    resolved_path: z.string().optional(),
  })
  .loose()

// `write_file` writes content to disk; its result is
// `{bytes_written, resolved_path, ...}`. The payload it wrote is far too large to
// echo, so the renderer keeps the resolved path and byte count as statistics.
const renderWriteFile: ToolRenderer<void> = (tool) => {
  const parsed = writeResultSchema.safeParse(tool.result?.details)
  const resolved = parsed.success ? parsed.data.resolved_path : undefined
  const bytes = parsed.success ? parsed.data.bytes_written : undefined
  const path = attr('path', resolved ?? asString(tool.input.path))
  const bytesAttr = bytes === undefined ? '' : ` bytes="${String(bytes)}"`
  return `<tool name="write_file"${path}${bytesAttr}${statusAttrs(tool)}/>`
}

// `patch` edits a file in place; its input is `{mode, path?, new_string, ...}`
// and its result may be `{error}` when Hermes refuses the edit. The new content
// is not echoed; the renderer keeps the mode and path and marks a refusal.
const renderPatch: ToolRenderer<void> = (tool) => {
  const mode = attr('mode', asString(tool.input.mode))
  const path = attr('path', asString(tool.input.path))
  return `<tool name="patch"${mode}${path}${statusAttrs(tool)}/>`
}

const searchResultSchema = z
  .object({ total_count: z.number().optional() })
  .loose()

// `search_files` greps the workspace; its input is `{pattern, path?}` and its
// result is `{total_count, matches_text, ...}`. The matches can span thousands of
// lines, so the renderer keeps the pattern and the match count.
const renderSearchFiles: ToolRenderer<void> = (tool) => {
  const pattern = attr('pattern', asString(tool.input.pattern))
  const path = attr('path', asString(tool.input.path))
  const parsed = searchResultSchema.safeParse(tool.result?.details)
  const total = parsed.success ? parsed.data.total_count : undefined
  const matches = total === undefined ? '' : ` matches="${String(total)}"`
  return `<tool name="search_files"${pattern}${path}${matches}${statusAttrs(
    tool,
  )}/>`
}

// Each todo item is re-parsed on its own, so one malformed entry drops only that
// task instead of erasing the whole rendered list.
const todoItemSchema = z
  .object({
    content: z.string().optional(),
    status: z.string().optional(),
  })
  .loose()
const todoInputSchema = z
  .object({ todos: z.array(z.unknown()).optional() })
  .loose()

// `todo` sets the working task list; its input is `{todos:[{content, status?}]}`.
// The renderer lists each task with its status.
const renderTodo: ToolRenderer<void> = (tool) => {
  const parsed = todoInputSchema.safeParse(tool.input)
  const todos = parsed.success ? (parsed.data.todos ?? []) : []
  const head = `<tool name="todo"${statusAttrs(tool)}`
  const body = todos
    .map((raw) => todoItemSchema.safeParse(raw))
    .filter((item) => item.success)
    .map((item) => {
      const status =
        item.data.status === undefined ? '' : `[${item.data.status}] `
      return `${status}${item.data.content ?? ''}`
    })
    .filter((line) => line.length > 0)
    .map(escapeText)
    .join('\n')
  return blockOrSelfClosing(head, body)
}

// `choices` holds unknown elements so one non-string entry drops only itself
// rather than erasing the whole choice list.
const clarifyInputSchema = z
  .object({
    question: z.string().optional(),
    choices: z.array(z.unknown()).optional(),
  })
  .loose()
const clarifyResultSchema = z
  .object({ question: z.string().optional() })
  .loose()

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

// `clarify` asks the human to choose; its input is `{question?, choices}` and its
// result echoes `{question, choices_offered}`. The renderer shows the question
// and lists the offered choices.
const renderClarify: ToolRenderer<void> = (tool) => {
  const input = clarifyInputSchema.safeParse(tool.input)
  const result = clarifyResultSchema.safeParse(tool.result?.details)
  const question =
    (result.success ? result.data.question : undefined) ??
    (input.success ? input.data.question : undefined) ??
    ''
  const choices = input.success ? (input.data.choices ?? []) : []
  const head = `<tool name="clarify"${attr('question', question)}${statusAttrs(
    tool,
  )}`
  const body = choices
    .filter(isString)
    .map((choice) => `- ${escapeText(choice)}`)
    .join('\n')
  return blockOrSelfClosing(head, body)
}

export const hermesTools: Record<string, ToolRenderer<void>> = {
  terminal: renderTerminal,
  skill_view: renderSkillView,
  read_file: renderReadFile,
  write_file: renderWriteFile,
  patch: renderPatch,
  search_files: renderSearchFiles,
  todo: renderTodo,
  clarify: renderClarify,
}

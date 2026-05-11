import { diffLines } from 'diff'
import { z } from 'zod'

export interface ToolUseInput {
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  content: string
  isError: boolean
}

const BASH_MAX_LINES = 200
const BASH_MAX_BYTES = 8 * 1024
const BASH_HEAD_LINES = 40
const BASH_TAIL_LINES = 40
const BASH_HEAD_BYTES = 4 * 1024
const BASH_TAIL_BYTES = 4 * 1024

const WRITE_VERBATIM_LINES = 60
const WRITE_HEAD_LINES = 30
const WRITE_TAIL_LINES = 10

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function attrEscape(s: string): string {
  return s.replaceAll('"', '&quot;')
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

function trimTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s
}

function headTailLines(text: string, headN: number, tailN: number): string {
  const lines = text.split('\n')
  if (lines.length <= headN + tailN) return text
  const head = lines.slice(0, headN)
  const tail = lines.slice(lines.length - tailN)
  const elided = lines.length - headN - tailN
  return [...head, `... (${elided} lines elided)`, ...tail].join('\n')
}

function headTailBytes(
  text: string,
  headBytes: number,
  tailBytes: number,
): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= headBytes + tailBytes) return text
  const head = buf.subarray(0, headBytes).toString('utf8')
  const tail = buf.subarray(buf.length - tailBytes).toString('utf8')
  const elided = buf.length - headBytes - tailBytes
  return `${head}\n... (${elided} bytes elided)\n${tail}`
}

function bashBody(content: string): string {
  const lineCount = countLines(content)
  const byteLen = Buffer.byteLength(content, 'utf8')
  const overLines = lineCount > BASH_MAX_LINES
  const overBytes = byteLen > BASH_MAX_BYTES
  if (!overLines && !overBytes) return trimTrailingNewline(content)
  if (overLines) {
    return headTailLines(
      trimTrailingNewline(content),
      BASH_HEAD_LINES,
      BASH_TAIL_LINES,
    )
  }
  return headTailBytes(
    trimTrailingNewline(content),
    BASH_HEAD_BYTES,
    BASH_TAIL_BYTES,
  )
}

export function renderBashTool(
  use: ToolUseInput,
  result: ToolResult | undefined,
): string {
  const cmd = asString(use.input.command)
  const cmdAttr = `cmd="${attrEscape(cmd)}"`
  if (result === undefined) {
    return `<tool name="Bash" ${cmdAttr}/>`
  }
  const exit = result.isError ? 1 : 0
  const body = bashBody(result.content)
  return `<tool name="Bash" ${cmdAttr} exit="${exit}">\n${body}\n</tool>`
}

export function renderWriteTool(use: ToolUseInput): string {
  const file = asString(use.input.file_path)
  const content = asString(use.input.content)
  const lines = countLines(content)
  const bytes = Buffer.byteLength(content, 'utf8')
  const fileAttr = `file="${attrEscape(file)}"`
  const head = `<tool name="Write" ${fileAttr} lines="${lines}" bytes="${bytes}">`
  const trimmed = trimTrailingNewline(content)
  const body =
    lines <= WRITE_VERBATIM_LINES
      ? trimmed
      : headTailLines(trimmed, WRITE_HEAD_LINES, WRITE_TAIL_LINES)
  return `${head}\n${body}\n</tool>`
}

function unifiedDiffBody(oldStr: string, newStr: string): string {
  const changes = diffLines(oldStr, newStr)
  const out: string[] = []
  for (const c of changes) {
    const prefix = c.added ? '+' : c.removed ? '-' : ' '
    const lines = c.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) out.push(prefix + line)
  }
  return out.join('\n')
}

export function renderEditTool(uses: ToolUseInput[]): string {
  const first = uses[0]
  if (first === undefined) return ''
  const file = asString(first.input.file_path)
  const fileAttr = `file="${attrEscape(file)}"`
  const diffs = uses.map((u) =>
    unifiedDiffBody(asString(u.input.old_string), asString(u.input.new_string)),
  )
  return `<tool name="Edit" ${fileAttr} patches="${uses.length}">\n${diffs.join('\n')}\n</tool>`
}

function selfClosing(name: string, attr: string, value: string): string {
  return `<tool name="${name}" ${attr}="${attrEscape(value)}"/>`
}

export function renderReadTool(use: ToolUseInput): string {
  return selfClosing('Read', 'path', asString(use.input.file_path))
}

export function renderGlobTool(use: ToolUseInput): string {
  return selfClosing('Glob', 'pattern', asString(use.input.pattern))
}

export function renderGrepTool(use: ToolUseInput): string {
  return selfClosing('Grep', 'pattern', asString(use.input.pattern))
}

export function renderSkillTool(use: ToolUseInput): string {
  return selfClosing('Skill', 'args', asString(use.input.args))
}

export function renderWebFetchTool(use: ToolUseInput): string {
  return selfClosing('WebFetch', 'url', asString(use.input.url))
}

export function renderWebSearchTool(use: ToolUseInput): string {
  return selfClosing('WebSearch', 'query', asString(use.input.query))
}

const AGENT_MAX_LINES = 200
const AGENT_HEAD_LINES = 40
const AGENT_TAIL_LINES = 40

function agentTruncate(text: string): string {
  const trimmed = trimTrailingNewline(text)
  if (countLines(trimmed) <= AGENT_MAX_LINES) return trimmed
  return headTailLines(trimmed, AGENT_HEAD_LINES, AGENT_TAIL_LINES)
}

export function renderAgentTool(
  use: ToolUseInput,
  result: ToolResult | undefined,
): string {
  const description = asString(use.input.description)
  const prompt = asString(use.input.prompt)
  const head = `<tool name="Agent" description="${attrEscape(description)}">`
  const promptBody = agentTruncate(prompt)
  if (result === undefined) {
    return `${head}\n${promptBody}\n</tool>`
  }
  const resultBody = agentTruncate(result.content)
  return `${head}\n${promptBody}\n---\n${resultBody}\n</tool>`
}

interface TodoItem {
  content: string
  status: string
}

function todoKey(t: TodoItem): string {
  return t.content
}

function diffLine(item: TodoItem, prev: TodoItem | undefined): string | null {
  if (prev === undefined) return `+ "${item.content}" → ${item.status}`
  if (prev.status === item.status) return null
  return `"${item.content}" → ${item.status}`
}

export function renderTodoWriteTool(
  prev: ReadonlyArray<TodoItem> | null,
  current: ReadonlyArray<TodoItem>,
): string {
  const prevMap = new Map<string, TodoItem>()
  if (prev !== null) for (const t of prev) prevMap.set(todoKey(t), t)
  const currentKeys = new Set(current.map(todoKey))

  const lines: string[] = []
  for (const item of current) {
    const line = diffLine(item, prevMap.get(todoKey(item)))
    if (line !== null) lines.push(line)
  }
  if (prev !== null) {
    for (const t of prev) {
      if (!currentKeys.has(todoKey(t))) lines.push(`- "${t.content}"`)
    }
  }
  if (lines.length === 0) return '<tool name="TodoWrite"/>'
  return `<tool name="TodoWrite">\n${lines.join('; ')}\n</tool>`
}

const askUserQuestionInputSchema = z.object({
  questions: z.array(z.object({ question: z.string().optional() })).optional(),
})

const askUserQuestionResultSchema = z.object({
  answers: z.record(z.string(), z.string()),
})

function parseAnswers(content: string): Record<string, string> {
  try {
    const parsed = askUserQuestionResultSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data.answers : {}
  } catch {
    return {}
  }
}

export function renderAskUserQuestionTool(
  use: ToolUseInput,
  result: ToolResult | undefined,
): string {
  const input = askUserQuestionInputSchema.safeParse(use.input)
  const questions = input.success ? (input.data.questions ?? []) : []
  const answers = result === undefined ? {} : parseAnswers(result.content)
  const lines = questions.map((q) => {
    const text = q.question ?? ''
    const ans = answers[text] ?? ''
    return `Q: ${text} → A: ${ans}`.replace(/\s+$/, '')
  })
  return `<tool name="AskUserQuestion">\n${lines.join('\n')}\n</tool>`
}

const UNKNOWN_MAX_LINES = 200
const UNKNOWN_HEAD_LINES = 40
const UNKNOWN_TAIL_LINES = 40

function unknownTruncate(text: string): string {
  const trimmed = trimTrailingNewline(text)
  if (countLines(trimmed) <= UNKNOWN_MAX_LINES) return trimmed
  return headTailLines(trimmed, UNKNOWN_HEAD_LINES, UNKNOWN_TAIL_LINES)
}

function flatAttrProjection(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') parts.push(`${k}="${attrEscape(v)}"`)
    else if (typeof v === 'number' || typeof v === 'boolean')
      parts.push(`${k}="${String(v)}"`)
  }
  return parts.join(' ')
}

export function renderUnknownTool(
  use: ToolUseInput,
  result: ToolResult | undefined,
): string {
  const attrs = flatAttrProjection(use.input)
  const head = `<tool name="${attrEscape(use.name)}"${attrs.length > 0 ? ` ${attrs}` : ''}`
  if (result === undefined) return `${head}/>`
  const body = unknownTruncate(result.content)
  return `${head}>\n${body}\n</tool>`
}

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

export function renderBashTool(
  use: ToolUseInput,
  result: ToolResult | undefined,
): string {
  const cmd = asString(use.input.command)
  const cmdAttr = `cmd="${attrEscape(cmd)}"`
  const errorAttr = result?.isError === true ? ' error="1"' : ''
  return `<tool name="Bash" ${cmdAttr}${errorAttr}/>`
}

export function renderWriteTool(use: ToolUseInput): string {
  const file = asString(use.input.file_path)
  const content = asString(use.input.content)
  const lines = countLines(content)
  const bytes = Buffer.byteLength(content, 'utf8')
  return `<tool name="Write" file="${attrEscape(file)}" lines="${lines}" bytes="${bytes}"/>`
}

export interface EditStats {
  patches: number
  added: number
  removed: number
}

export function editStats(
  oldStr: string,
  newStr: string,
): { added: number; removed: number } {
  const changes = diffLines(oldStr, newStr)
  let added = 0
  let removed = 0
  for (const c of changes) {
    const lines = c.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    if (c.added) added += lines.length
    else if (c.removed) removed += lines.length
  }
  return { added, removed }
}

export function renderEditTool(file: string, stats: EditStats): string {
  return `<tool name="Edit" file="${attrEscape(file)}" patches="${stats.patches}" added="${stats.added}" removed="${stats.removed}"/>`
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

export function renderAgentTool(use: ToolUseInput): string {
  const description = asString(use.input.description)
  return `<tool name="Agent" description="${attrEscape(description)}"/>`
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
  const errorAttr = result?.isError === true ? ' error="1"' : ''
  const attrPart = attrs.length > 0 ? ` ${attrs}` : ''
  return `<tool name="${attrEscape(use.name)}"${attrPart}${errorAttr}/>`
}

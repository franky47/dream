import { z } from 'zod'

import {
  type ClaudeEntry,
  type ContentPart,
  entryText,
  parseEntries,
  stripFraming,
  toolResultContent,
} from './entries.ts'
import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'
import { applyPostPasses } from './post-pass.ts'
import {
  renderAgentTool,
  renderAskUserQuestionTool,
  renderBashTool,
  renderEditTool,
  renderGlobTool,
  renderGrepTool,
  renderReadTool,
  renderSkillTool,
  renderTodoWriteTool,
  renderUnknownTool,
  renderWebFetchTool,
  renderWebSearchTool,
  renderWriteTool,
  type ToolResult,
  type ToolUseInput,
} from './tools.ts'

const DROPPED_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'file-history-snapshot',
  'last-prompt',
  'permission-mode',
  'queue-operation',
  'attachment',
  'system',
  'ai-title',
])

function asFilePath(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const todoItemSchema = z.object({
  content: z.string(),
  status: z.string(),
})

type TodoItem = z.infer<typeof todoItemSchema>

function asTodos(v: unknown): TodoItem[] {
  if (!Array.isArray(v)) return []
  const out: TodoItem[] = []
  for (const item of v) {
    const parsed = todoItemSchema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

interface ToolUseRef {
  id: string | null
  name: string
  input: Record<string, unknown>
}

function toToolUseInput(part: ContentPart): ToolUseRef | null {
  if (part.type !== 'tool_use') return null
  const id = 'id' in part && part.id !== undefined ? part.id : null
  const name = 'name' in part ? (part.name ?? 'unknown') : 'unknown'
  const input = 'input' in part ? (part.input ?? {}) : {}
  return { id, name, input }
}

function collectToolResults(
  entries: ReadonlyArray<ClaudeEntry>,
): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>()
  for (const e of entries) {
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c.type !== 'tool_result') continue
      const id =
        'tool_use_id' in c && c.tool_use_id !== undefined ? c.tool_use_id : null
      if (id === null) continue
      const isError = 'is_error' in c && c.is_error === true
      out.set(id, { content: toolResultContent(c), isError })
    }
  }
  return out
}

function collectToolUses(entries: ReadonlyArray<ClaudeEntry>): ToolUseRef[] {
  const out: ToolUseRef[] = []
  for (const e of entries) {
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      const u = toToolUseInput(c)
      if (u !== null) out.push(u)
    }
  }
  return out
}

function computeEditGroups(uses: ReadonlyArray<ToolUseRef>): {
  headGroup: Map<string, ToolUseInput[]>
  absorbed: Set<string>
} {
  const headGroup = new Map<string, ToolUseInput[]>()
  const absorbed = new Set<string>()
  let i = 0
  while (i < uses.length) {
    const u = uses[i]
    if (u === undefined || u.name !== 'Edit' || u.id === null) {
      i += 1
      continue
    }
    const file = asFilePath(u.input.file_path)
    const group: ToolUseInput[] = [{ name: u.name, input: u.input }]
    let j = i + 1
    while (j < uses.length) {
      const next = uses[j]
      if (
        next === undefined ||
        next.name !== 'Edit' ||
        asFilePath(next.input.file_path) !== file
      ) {
        break
      }
      group.push({ name: next.name, input: next.input })
      if (next.id !== null) absorbed.add(next.id)
      j += 1
    }
    headGroup.set(u.id, group)
    i = j
  }
  return { headGroup, absorbed }
}

interface RenderState {
  results: ReadonlyMap<string, ToolResult>
  editGroups: ReadonlyMap<string, ToolUseInput[]>
  absorbed: ReadonlySet<string>
  bodyDedup: Map<string, number>
  lastTodos: TodoItem[] | null
  currentTurn: number
}

function resultFor(
  use: ToolUseRef,
  state: RenderState,
): ToolResult | undefined {
  return use.id !== null ? state.results.get(use.id) : undefined
}

interface Reduced {
  xml: string
  // True when the body comes from a tool_result; eligible for cross-turn dedup.
  resultBacked: boolean
}

function reduceToolUse(use: ToolUseRef, state: RenderState): Reduced {
  const input: ToolUseInput = { name: use.name, input: use.input }
  if (use.name === 'Edit') {
    if (use.id !== null && state.absorbed.has(use.id)) {
      return { xml: '', resultBacked: false }
    }
    const group = use.id !== null ? state.editGroups.get(use.id) : undefined
    return { xml: renderEditTool(group ?? [input]), resultBacked: false }
  }
  if (use.name === 'Bash') {
    return {
      xml: renderBashTool(input, resultFor(use, state)),
      resultBacked: true,
    }
  }
  if (use.name === 'Write') {
    return { xml: renderWriteTool(input), resultBacked: false }
  }
  if (use.name === 'Read')
    return { xml: renderReadTool(input), resultBacked: false }
  if (use.name === 'Glob')
    return { xml: renderGlobTool(input), resultBacked: false }
  if (use.name === 'Grep')
    return { xml: renderGrepTool(input), resultBacked: false }
  if (use.name === 'Skill')
    return { xml: renderSkillTool(input), resultBacked: false }
  if (use.name === 'WebFetch')
    return { xml: renderWebFetchTool(input), resultBacked: false }
  if (use.name === 'WebSearch')
    return { xml: renderWebSearchTool(input), resultBacked: false }
  if (use.name === 'Agent') {
    return {
      xml: renderAgentTool(input, resultFor(use, state)),
      resultBacked: true,
    }
  }
  if (use.name === 'AskUserQuestion') {
    return {
      xml: renderAskUserQuestionTool(input, resultFor(use, state)),
      resultBacked: true,
    }
  }
  if (use.name === 'TodoWrite') {
    const current = asTodos(use.input.todos)
    const xml = renderTodoWriteTool(state.lastTodos, current)
    state.lastTodos = current
    return { xml, resultBacked: false }
  }
  return {
    xml: renderUnknownTool(input, resultFor(use, state)),
    resultBacked: true,
  }
}

function postProcessRendered(reduced: Reduced, state: RenderState): string {
  const { xml, resultBacked } = reduced
  if (xml.length === 0) return xml
  if (xml.endsWith('/>')) return xml
  const lines = xml.split('\n')
  if (lines.length < 3) return xml
  if (lines[lines.length - 1] !== '</tool>') return xml
  const head = lines[0]
  const body = lines.slice(1, -1).join('\n')
  const cleaned = applyPostPasses(body)
  if (resultBacked && cleaned.length > 0) {
    const seenTurn = state.bodyDedup.get(cleaned)
    if (seenTurn !== undefined) {
      return `${head}\n(same output as turn ${seenTurn})\n</tool>`
    }
    state.bodyDedup.set(cleaned, state.currentTurn)
  }
  return `${head}\n${cleaned}\n</tool>`
}

function dispatchToolUse(use: ToolUseRef, state: RenderState): string {
  return postProcessRendered(reduceToolUse(use, state), state)
}

function renderAssistantBody(
  entry: ClaudeEntry,
  dispatch: (use: ToolUseRef) => string,
): string {
  const content = entry.message?.content
  if (content === undefined) return ''
  if (typeof content === 'string') return content.trim()
  const out: string[] = []
  for (const c of content) {
    if (c.type === 'thinking') continue
    if (c.type === 'text' && 'text' in c) {
      const t = c.text.trim()
      if (t.length > 0) out.push(t)
    } else if (c.type === 'tool_use') {
      const u = toToolUseInput(c)
      if (u === null) continue
      const rendered = dispatch(u)
      if (rendered.length > 0) out.push(rendered)
    }
  }
  return out.join('\n')
}

function renderUserBody(entry: ClaudeEntry): string {
  return stripFraming(entryText(entry))
}

function formatDelta(startMs: number, currentMs: number): string {
  const totalSec = Math.max(0, Math.round((currentMs - startMs) / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `+${m}m${s.toString().padStart(2, '0')}s`
}

function turnMarker(opts: {
  n: number
  role: 'user' | 'assistant'
  t: string | null
}): string {
  const tAttr = opts.t === null ? '' : ` t="${opts.t}"`
  return `<turn n="${opts.n}" role="${opts.role}"${tAttr}/>`
}

export function renderClaudeSession(jsonlText: string): string {
  const entries = parseEntries(jsonlText)
  const fm = extractFrontmatter(jsonlText)
  const yaml = frontmatterToYaml(fm)

  const results = collectToolResults(entries)
  const uses = collectToolUses(entries)
  const { headGroup, absorbed } = computeEditGroups(uses)
  const state: RenderState = {
    results,
    editGroups: headGroup,
    absorbed,
    bodyDedup: new Map(),
    lastTodos: null,
    currentTurn: 0,
  }
  const dispatch = (u: ToolUseRef): string => dispatchToolUse(u, state)

  const turnable = entries.filter(
    (e) =>
      !DROPPED_ENTRY_TYPES.has(e.type) &&
      (e.type === 'user' || e.type === 'assistant'),
  )

  let firstStampMs: number | null = null
  let turnCount = 0
  const bodyParts: string[] = []
  for (const e of turnable) {
    turnCount += 1
    state.currentTurn = turnCount
    const role = e.type === 'user' ? 'user' : 'assistant'
    let t: string | null
    if (e.timestamp === undefined) {
      t = null
    } else {
      const ms = Date.parse(e.timestamp)
      if (Number.isNaN(ms)) {
        t = null
      } else if (firstStampMs === null) {
        firstStampMs = ms
        t = '0'
      } else {
        t = formatDelta(firstStampMs, ms)
      }
    }
    bodyParts.push(turnMarker({ n: turnCount, role, t }))
    const body =
      role === 'user' ? renderUserBody(e) : renderAssistantBody(e, dispatch)
    if (body.length > 0) bodyParts.push(body)
  }

  return `${yaml}\n${bodyParts.join('\n')}\n`
}

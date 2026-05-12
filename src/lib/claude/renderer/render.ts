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
import {
  type EditStats,
  editStats,
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

function asString(v: unknown): string {
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
  headStats: Map<string, EditStats>
  absorbed: Set<string>
} {
  const headStats = new Map<string, EditStats>()
  const absorbed = new Set<string>()
  let i = 0
  while (i < uses.length) {
    const u = uses[i]
    if (u === undefined || u.name !== 'Edit' || u.id === null) {
      i += 1
      continue
    }
    const file = asFilePath(u.input.file_path)
    const first = editStats(
      asString(u.input.old_string),
      asString(u.input.new_string),
    )
    let added = first.added
    let removed = first.removed
    let patches = 1
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
      const s = editStats(
        asString(next.input.old_string),
        asString(next.input.new_string),
      )
      added += s.added
      removed += s.removed
      patches += 1
      if (next.id !== null) absorbed.add(next.id)
      j += 1
    }
    headStats.set(u.id, { patches, added, removed })
    i = j
  }
  return { headStats, absorbed }
}

interface RenderState {
  results: ReadonlyMap<string, ToolResult>
  editStats: ReadonlyMap<string, EditStats>
  absorbed: ReadonlySet<string>
  lastTodos: TodoItem[] | null
}

function resultFor(
  use: ToolUseRef,
  state: RenderState,
): ToolResult | undefined {
  return use.id !== null ? state.results.get(use.id) : undefined
}

function dispatchToolUse(use: ToolUseRef, state: RenderState): string {
  if (use.name === 'Edit') {
    if (use.id !== null && state.absorbed.has(use.id)) return ''
    const stats =
      (use.id !== null ? state.editStats.get(use.id) : undefined) ??
      (() => {
        const s = editStats(
          asString(use.input.old_string),
          asString(use.input.new_string),
        )
        return { patches: 1, added: s.added, removed: s.removed }
      })()
    return renderEditTool(asFilePath(use.input.file_path), stats)
  }
  if (use.name === 'Bash')
    return renderBashTool(
      { name: use.name, input: use.input },
      resultFor(use, state),
    )
  if (use.name === 'Write')
    return renderWriteTool({ name: use.name, input: use.input })
  if (use.name === 'Read')
    return renderReadTool({ name: use.name, input: use.input })
  if (use.name === 'Glob')
    return renderGlobTool({ name: use.name, input: use.input })
  if (use.name === 'Grep')
    return renderGrepTool({ name: use.name, input: use.input })
  if (use.name === 'Skill')
    return renderSkillTool({ name: use.name, input: use.input })
  if (use.name === 'WebFetch')
    return renderWebFetchTool({ name: use.name, input: use.input })
  if (use.name === 'WebSearch')
    return renderWebSearchTool({ name: use.name, input: use.input })
  if (use.name === 'Agent')
    return renderAgentTool({ name: use.name, input: use.input })
  if (use.name === 'AskUserQuestion')
    return renderAskUserQuestionTool(
      { name: use.name, input: use.input },
      resultFor(use, state),
    )
  if (use.name === 'TodoWrite') {
    const current = asTodos(use.input.todos)
    const xml = renderTodoWriteTool(state.lastTodos, current)
    state.lastTodos = current
    return xml
  }
  return renderUnknownTool(
    { name: use.name, input: use.input },
    resultFor(use, state),
  )
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
  const { headStats, absorbed } = computeEditGroups(uses)
  const state: RenderState = {
    results,
    editStats: headStats,
    absorbed,
    lastTodos: null,
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

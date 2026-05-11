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
  renderBashTool,
  renderEditTool,
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

function attrEscape(s: string): string {
  return s.replaceAll('"', '&quot;')
}

function asAttrValue(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return null
}

function asFilePath(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function renderGenericTool(use: ToolUseInput): string {
  const attrs: string[] = []
  for (const [k, v] of Object.entries(use.input)) {
    const s = asAttrValue(v)
    if (s !== null) attrs.push(`${k}="${attrEscape(s)}"`)
  }
  const head = `<tool name="${attrEscape(use.name)}"`
  return attrs.length > 0 ? `${head} ${attrs.join(' ')}/>` : `${head}/>`
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

function dispatchToolUse(
  use: ToolUseRef,
  results: ReadonlyMap<string, ToolResult>,
  editGroups: ReadonlyMap<string, ToolUseInput[]>,
  absorbed: ReadonlySet<string>,
): string {
  if (use.name === 'Edit') {
    if (use.id !== null && absorbed.has(use.id)) return ''
    const group = use.id !== null ? editGroups.get(use.id) : undefined
    return renderEditTool(group ?? [{ name: use.name, input: use.input }])
  }
  if (use.name === 'Bash') {
    const result = use.id !== null ? results.get(use.id) : undefined
    return renderBashTool({ name: use.name, input: use.input }, result)
  }
  if (use.name === 'Write') {
    return renderWriteTool({ name: use.name, input: use.input })
  }
  return renderGenericTool({ name: use.name, input: use.input })
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
  const dispatch = (u: ToolUseRef): string =>
    dispatchToolUse(u, results, headGroup, absorbed)

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

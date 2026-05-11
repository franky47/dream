import {
  type ClaudeEntry,
  type ContentPart,
  entryText,
  parseEntries,
  stripFraming,
} from './entries.ts'
import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

const DROPPED_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'file-history-snapshot',
  'last-prompt',
  'permission-mode',
  'queue-operation',
  'attachment',
  'system',
  'ai-title',
])

function attrEscape(v: unknown): string {
  return String(v).replaceAll('"', '&quot;')
}

function renderToolUse(part: ContentPart): string {
  if (part.type !== 'tool_use') return ''
  const name = 'name' in part ? (part.name ?? 'unknown') : 'unknown'
  const inputs = 'input' in part ? (part.input ?? {}) : {}
  const attrs = Object.entries(inputs)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => `${k}="${attrEscape(v)}"`)
  const head = `<tool name="${attrEscape(name)}"`
  return attrs.length > 0 ? `${head} ${attrs.join(' ')}/>` : `${head}/>`
}

function renderAssistantBody(entry: ClaudeEntry): string {
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
      out.push(renderToolUse(c))
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
    const body = role === 'user' ? renderUserBody(e) : renderAssistantBody(e)
    if (body.length > 0) bodyParts.push(body)
  }

  return `${yaml}\n${bodyParts.join('\n')}\n`
}

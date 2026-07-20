import { z } from 'zod'

import {
  type Frontmatter,
  frontmatterToYaml,
  scalarPlatformFields,
} from './frontmatter.ts'
import { isRewound } from './rewound.ts'
import { renderHermesSession } from './session.ts'

const RENDERER_VERSION = 'hermes-md@1'

// Hermes wraps a compaction summary between these stable markers and prepends a
// safety prefix that instructs the model. The renderer keeps only the body
// between the markers, dropping both the prefix and the closing marker.
const COMPACTION_BEGIN = '[hermes:compaction-summary]'
const COMPACTION_END = '[/hermes:compaction-summary]'

const sessionRowSchema = z.object({
  type: z.literal('session'),
  sessionId: z.string(),
  source: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  platform: z.unknown().optional(),
  archived: z.number().nullable().optional(),
})

const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number(),
  turn: z.number().optional(),
})

type SessionRow = z.infer<typeof sessionRowSchema>
type MessageRow = z.infer<typeof messageRowSchema>

export interface HermesFragment {
  contextWindow: number | null
  markdown: string
}

interface WindowSpec {
  session: SessionRow
  summary: MessageRow | null
  turns: MessageRow[]
  contextWindow: number
  nextContextWindow: number | null
}

function parseRows(jsonlText: string): unknown[] {
  const out: unknown[] = []
  for (const line of jsonlText.split('\n')) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return out
}

function isCompactionSummary(content: string): boolean {
  return content.includes(COMPACTION_BEGIN) && content.includes(COMPACTION_END)
}

function cleanSummaryBody(content: string): string {
  const start = content.indexOf(COMPACTION_BEGIN) + COMPACTION_BEGIN.length
  const end = content.indexOf(COMPACTION_END)
  return content.slice(start, end).trim()
}

function formatDelta(startMs: number, currentMs: number): string {
  const totalSec = Math.max(0, Math.round((currentMs - startMs) / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `+${m}m${s.toString().padStart(2, '0')}s`
}

function renderCompactionBlock(summary: MessageRow): string {
  const body = cleanSummaryBody(summary.content)
  const turnAttr = summary.turn === undefined ? '' : ` turn="${summary.turn}"`
  return `<compaction${turnAttr} role="${summary.role}" t="0">\n${body}\n</compaction>`
}

function renderWindowBody(spec: WindowSpec): string {
  const timeline =
    spec.summary === null ? spec.turns : [spec.summary, ...spec.turns]
  const lines: string[] = []
  let firstStampMs: number | null = null
  let n = 0

  for (let i = 0; i < timeline.length; i += 1) {
    const msg = timeline[i]!
    const t =
      firstStampMs === null ? '0' : formatDelta(firstStampMs, msg.createdAt)
    firstStampMs ??= msg.createdAt

    if (spec.summary !== null && i === 0) {
      lines.push(renderCompactionBlock(msg))
      continue
    }

    n += 1
    lines.push(`<turn n="${n}" role="${msg.role}" t="${t}"/>`)
    const body = msg.content.trim()
    if (body.length > 0) lines.push(body)
  }

  if (spec.nextContextWindow !== null) {
    const href = `./${spec.session.sessionId}.${spec.nextContextWindow}.md`
    lines.push(
      `[Continue in context window ${spec.nextContextWindow} →](${href})`,
    )
  }

  return lines.join('\n')
}

function buildWindowFrontmatter(spec: WindowSpec): Frontmatter {
  const timeline =
    spec.summary === null ? spec.turns : [spec.summary, ...spec.turns]
  const startedAt =
    timeline.length > 0 ? new Date(timeline[0]!.createdAt).toISOString() : ''
  const endedAt =
    timeline.length > 0
      ? new Date(timeline[timeline.length - 1]!.createdAt).toISOString()
      : ''

  const fm: Frontmatter = {
    sessionId: spec.session.sessionId,
    source: spec.session.source ?? '',
    title: spec.session.title ?? '',
    archived: (spec.session.archived ?? 0) > 0,
    startedAt,
    endedAt,
    turns: spec.turns.filter((m) => m.role === 'user').length,
    tools: 0,
    contextWindow: spec.contextWindow,
    platform: scalarPlatformFields(spec.session.platform),
    renderer: RENDERER_VERSION,
  }
  if (spec.nextContextWindow !== null) {
    fm.nextContextWindow = spec.nextContextWindow
  }
  return fm
}

function renderWindow(spec: WindowSpec): HermesFragment {
  const markdown = `${frontmatterToYaml(buildWindowFrontmatter(spec))}\n${renderWindowBody(spec)}\n`
  return { contextWindow: spec.contextWindow, markdown }
}

function firstSession(raws: readonly unknown[]): SessionRow | null {
  for (const raw of raws) {
    const parsed = sessionRowSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  }
  return null
}

function collectMessages(raws: readonly unknown[]): MessageRow[] {
  const out: MessageRow[] = []
  for (const raw of raws) {
    if (isRewound(raw)) continue
    const parsed = messageRowSchema.safeParse(raw)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

// A logical Hermes session becomes one fragment per context window. Without a
// compaction it stays a single unnumbered file, byte-identical to the basic
// renderer. Each compaction summary opens a new window: an in-place compaction
// marks its summary mid-stream, while a rotated continuation carries its
// summary as the first message of the next physical session. Both forms join
// into one message stream here, so each summary starts a window that shows the
// summary plus the tail it preserved. A leading archived window precedes them
// only when real turns come before the first summary; an orphaned continuation
// whose stream opens with a summary skips that empty window.
export function renderHermesFragments(jsonlText: string): HermesFragment[] {
  const raws = parseRows(jsonlText)
  const session = firstSession(raws)
  const messages = collectMessages(raws)
  const summaryIndices = messages
    .map((m, i) => (isCompactionSummary(m.content) ? i : -1))
    .filter((i) => i !== -1)

  if (session === null || summaryIndices.length === 0) {
    return [{ contextWindow: null, markdown: renderHermesSession(jsonlText) }]
  }

  const hasLeadingArchive = summaryIndices[0] !== 0
  const starts = hasLeadingArchive ? [0, ...summaryIndices] : summaryIndices
  return starts.map((start, w) => {
    const isSummaryWindow = w > 0 || !hasLeadingArchive
    const contextWindow = w + 1
    return renderWindow({
      session,
      summary: isSummaryWindow ? messages[start]! : null,
      turns: messages.slice(isSummaryWindow ? start + 1 : start, starts[w + 1]),
      contextWindow,
      nextContextWindow:
        contextWindow < starts.length ? contextWindow + 1 : null,
    })
  })
}

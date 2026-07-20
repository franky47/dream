import { z } from 'zod'

import {
  type Frontmatter,
  frontmatterToYaml,
  scalarPlatformFields,
} from './frontmatter.ts'
import { isRewound } from './rewound.ts'
import { renderHermesSession } from './session.ts'

const RENDERER_VERSION = 'hermes-md@1'

// Hermes wraps a compaction summary between stable bracket markers and prepends
// a safety prefix that instructs the model. The renderer keeps only the body
// between the markers, dropping the prefix and both markers.
//
// The marker has three recognised forms: the current build, an older build that
// used a shorter tag before the "compaction" rename, and a merged summary that
// folds an earlier window's summary into a later compaction. A merged body can
// carry a nested current marker, so cleanup strips every known token, not just
// the outer pair.
interface MarkerForm {
  begin: string
  end: string
}

const MARKER_FORMS: readonly MarkerForm[] = [
  { begin: '[hermes:compaction-summary]', end: '[/hermes:compaction-summary]' },
  { begin: '[hermes:summary]', end: '[/hermes:summary]' },
  {
    begin: '[hermes:compaction-summary:merged]',
    end: '[/hermes:compaction-summary:merged]',
  },
]

const MARKER_TOKENS: readonly string[] = MARKER_FORMS.flatMap((form) => [
  form.begin,
  form.end,
])

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

// The outer marker is whichever begin token appears earliest; a merged summary
// opens with its own tag before any nested current tag. Detection needs that
// literal token, so ordinary prose mentioning a summary is never mistaken for a
// compaction event.
function outerMarker(content: string): { form: MarkerForm; at: number } | null {
  let best: { form: MarkerForm; at: number } | null = null
  for (const form of MARKER_FORMS) {
    const at = content.indexOf(form.begin)
    if (at === -1) continue
    if (best === null || at < best.at) best = { form, at }
  }
  return best
}

function isCompactionSummary(content: string): boolean {
  return outerMarker(content) !== null
}

// Keep the body between the outer begin marker and the last matching end marker,
// falling back to the end of the content when Hermes wrote no closing marker.
// Any nested markers a merged summary carried are stripped from the body.
function cleanSummaryBody(content: string): string {
  const outer = outerMarker(content)
  if (outer === null) return content.trim()

  const start = outer.at + outer.form.begin.length
  const closeAt = content.lastIndexOf(outer.form.end)
  const end = closeAt === -1 ? content.length : closeAt
  let body = content.slice(start, end)
  for (const token of MARKER_TOKENS) body = body.replaceAll(token, '')
  return collapseBlankLines(body).trim()
}

// A newline is a control character, so oxlint's no-control-regex rejects it as a
// literal; build the pattern from its char code instead.
const NEWLINE = String.fromCharCode(10)
const BLANK_LINE_RUN = new RegExp(`${NEWLINE}{3,}`, 'g')

function collapseBlankLines(text: string): string {
  return text.replaceAll(BLANK_LINE_RUN, `${NEWLINE}${NEWLINE}`)
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

function summaryIndices(messages: readonly MessageRow[]): number[] {
  const out: number[] = []
  for (let i = 0; i < messages.length; i += 1) {
    if (isCompactionSummary(messages[i]!.content)) out.push(i)
  }
  return out
}

// A logical Hermes session becomes one fragment per context window. Without a
// compaction it stays a single unnumbered file, byte-identical to the basic
// renderer. N in-place compactions yield N+1 fragments: the first window holds
// the archived conversation, and every later window opens with a summary plus
// the tail Hermes preserved. Each summary marks the boundary between two
// windows.
export function renderHermesFragments(jsonlText: string): HermesFragment[] {
  const raws = parseRows(jsonlText)
  const session = firstSession(raws)
  const messages = collectMessages(raws)
  const summaries = summaryIndices(messages)

  if (session === null || summaries.length === 0) {
    return [{ contextWindow: null, markdown: renderHermesSession(jsonlText) }]
  }

  const windowCount = summaries.length + 1
  const fragments: HermesFragment[] = []
  for (let w = 0; w < windowCount; w += 1) {
    const isFirst = w === 0
    const isLast = w === windowCount - 1
    const summaryIndex = isFirst ? null : summaries[w - 1]!
    const start = summaryIndex === null ? 0 : summaryIndex + 1
    const end = isLast ? messages.length : summaries[w]!
    fragments.push(
      renderWindow({
        session,
        summary: summaryIndex === null ? null : messages[summaryIndex]!,
        turns: messages.slice(start, end),
        contextWindow: w + 1,
        nextContextWindow: isLast ? null : w + 2,
      }),
    )
  }
  return fragments
}

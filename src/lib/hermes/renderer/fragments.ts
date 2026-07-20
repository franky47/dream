import { z } from 'zod'

import { renderConversation } from '#lib/renderer/render'
import type { NormalizedMessage } from '#lib/renderer/types'

import {
  type Frontmatter,
  frontmatterToYaml,
  scalarPlatformFields,
} from './frontmatter.ts'
import { normalizeMessages } from './normalize.ts'
import { isRewound } from './rewound.ts'
import { hermesRenderConfig, renderHermesSession } from './session.ts'

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

// Permissive on role so tool-result rows (role "tool") survive to the normalize
// pipeline instead of dropping out of the fragment stream. Downstream code owns
// the role split; here every message row is a window member.
const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.string(),
  content: z.string(),
  createdAt: z.number(),
  turn: z.number().optional(),
})

type SessionRow = z.infer<typeof sessionRowSchema>
type MessageRow = z.infer<typeof messageRowSchema>

interface MessageEntry {
  raw: unknown
  row: MessageRow
  isSummary: boolean
}

export interface HermesFragment {
  contextWindow: number | null
  markdown: string
}

interface WindowSpec {
  session: SessionRow
  summary: MessageEntry | null
  windowEntries: readonly MessageEntry[]
  bodyMessages: readonly NormalizedMessage[]
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

function renderCompactionBlock(summary: MessageRow): string {
  const body = cleanSummaryBody(summary.content)
  const turnAttr = summary.turn === undefined ? '' : ` turn="${summary.turn}"`
  return `<compaction${turnAttr} role="${summary.role}" t="0">\n${body}\n</compaction>`
}

function renderWindowBody(spec: WindowSpec): string {
  const lines: string[] = []
  if (spec.summary !== null) {
    lines.push(renderCompactionBlock(spec.summary.row))
  }

  const anchorMs = spec.summary?.row.createdAt ?? null
  const turns = renderConversation(
    spec.bodyMessages,
    hermesRenderConfig,
    anchorMs,
  )
  if (turns.length > 0) lines.push(turns)

  if (spec.nextContextWindow !== null) {
    const href = `./${spec.session.sessionId}.${spec.nextContextWindow}.md`
    lines.push(
      `[Continue in context window ${spec.nextContextWindow} →](${href})`,
    )
  }

  return lines.join('\n')
}

function countTools(messages: readonly NormalizedMessage[]): number {
  let n = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === 'tool') n += 1
    }
  }
  return n
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString()
}

function buildWindowFrontmatter(spec: WindowSpec): Frontmatter {
  const entries = spec.windowEntries
  const startedAt =
    entries.length > 0 ? isoStamp(entries[0]!.row.createdAt) : ''
  const endedAt =
    entries.length > 0
      ? isoStamp(entries[entries.length - 1]!.row.createdAt)
      : ''

  const fm: Frontmatter = {
    sessionId: spec.session.sessionId,
    source: spec.session.source ?? '',
    title: spec.session.title ?? '',
    archived: (spec.session.archived ?? 0) > 0,
    startedAt,
    endedAt,
    turns: spec.bodyMessages.filter((m) => m.role === 'user').length,
    tools: countTools(spec.bodyMessages),
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

// Live message rows in order, each tagged with whether it opens a context
// window. Rewound rows never enter the stream, so they cannot start a window or
// skew a window's counts or time bounds.
function collectEntries(raws: readonly unknown[]): MessageEntry[] {
  const out: MessageEntry[] = []
  for (const raw of raws) {
    if (isRewound(raw)) continue
    const parsed = messageRowSchema.safeParse(raw)
    if (!parsed.success) continue
    out.push({
      raw,
      row: parsed.data,
      isSummary: isCompactionSummary(parsed.data.content),
    })
  }
  return out
}

function summaryPositions(entries: readonly MessageEntry[]): number[] {
  const out: number[] = []
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]!.isSummary) out.push(i)
  }
  return out
}

// A logical Hermes session becomes one fragment per context window. Without a
// compaction it stays a single unnumbered file, byte-identical to the basic
// renderer. Each compaction summary opens a new window, so N summaries yield
// N+1 fragments when real turns precede the first summary: an in-place
// compaction marks its summary mid-stream, while a rotated continuation
// carries its summary as the first message of the next physical session. Both
// forms join into one message stream here, so each summary starts a window
// that shows the summary plus the tail it preserved. A leading archived window
// precedes them only when real turns come before the first summary; an
// orphaned continuation whose stream opens with a summary skips that empty
// window.
//
// Each window's body flows through the same normalize + render machinery as the
// unnumbered path, so tool calls pair and render, Discord notes strip, and
// rewound rows drop identically. Only the compaction block and the relative
// next-window link are fragment-level concerns.
export function renderHermesFragments(jsonlText: string): HermesFragment[] {
  const raws = parseRows(jsonlText)
  const session = firstSession(raws)
  const entries = collectEntries(raws)
  const summaries = summaryPositions(entries)

  if (session === null || summaries.length === 0) {
    return [{ contextWindow: null, markdown: renderHermesSession(jsonlText) }]
  }

  const hasLeadingArchive = summaries[0] !== 0
  const starts = hasLeadingArchive ? [0, ...summaries] : summaries
  return starts.map((start, w) => {
    const isSummaryWindow = w > 0 || !hasLeadingArchive
    const end = starts[w + 1] ?? entries.length
    const windowEntries = entries.slice(start, end)
    const summary = isSummaryWindow ? windowEntries[0]! : null
    const bodyEntries =
      summary === null ? windowEntries : windowEntries.slice(1)
    const contextWindow = w + 1
    return renderWindow({
      session,
      summary,
      windowEntries,
      bodyMessages: normalizeMessages(bodyEntries.map((e) => e.raw)),
      contextWindow,
      nextContextWindow:
        contextWindow < starts.length ? contextWindow + 1 : null,
    })
  })
}

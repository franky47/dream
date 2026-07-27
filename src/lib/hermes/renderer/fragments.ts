import { z } from 'zod'

import { COMPACTION_SUMMARY_PREFIX } from '#lib/hermes/compaction'
import { renderConversation } from '#lib/renderer/render'
import type { NormalizedMessage } from '#lib/renderer/types'

import {
  type Frontmatter,
  frontmatterToYaml,
  scalarPlatformFields,
  sessionRowSchema,
} from './frontmatter.ts'
import { normalizeMessages } from './normalize.ts'
import { isRewound } from './rewound.ts'
import { hermesRenderConfig, renderHermesSession } from './session.ts'

const RENDERER_VERSION = 'hermes-md@1'

// Hermes marks a compaction summary with a fixed instruction prefix and a fixed
// end marker, both wrapping the real Markdown summary body. Detection keys on
// the shared opening marker; cleaning drops everything through the instruction's
// final `avoid repeating it:` phrase and the trailing end-marker line, leaving
// only the summary the model was handed.
const INSTRUCTION_END = 'avoid repeating it:'
const END_MARKER =
  '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'

// Permissive on role and content so tool-result rows (role "tool", whose content
// is null when the payload lives elsewhere) and every other message row survive
// to the normalize pipeline as window members. Downstream code owns the role
// split; here every non-meta message row is a window member.
const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.string(),
  content: z.string().nullish(),
  createdAt: z.number(),
})

type MessageRow = z.infer<typeof messageRowSchema>

// A joined logical session carries several physical session headers. Frontmatter
// describes the joined whole, not the first physical row: it keeps the root's
// id, takes the first non-empty source and title in chain order, folds the
// platform IDs of every member (root first, later members only fill gaps), and
// marks the whole archived if any member is.
interface MergedSession {
  sessionId: string
  source: string
  title: string
  archived: boolean
  platform: Frontmatter['platform']
}

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
  session: MergedSession
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

function isCompactionSummary(content: string | null | undefined): boolean {
  return (
    typeof content === 'string' && content.startsWith(COMPACTION_SUMMARY_PREFIX)
  )
}

// Keep only the Markdown summary body: drop the instruction prefix through its
// closing `avoid repeating it:` phrase (falling back to just the detection marker
// when Hermes changes the wording), then drop the trailing end-marker line.
function cleanSummaryBody(content: string): string {
  const instructionAt = content.indexOf(INSTRUCTION_END)
  const start =
    instructionAt === -1
      ? COMPACTION_SUMMARY_PREFIX.length
      : instructionAt + INSTRUCTION_END.length
  const endAt = content.indexOf(END_MARKER)
  const body = endAt === -1 ? content.slice(start) : content.slice(start, endAt)
  return collapseBlankLines(body).trim()
}

// A newline is a control character, so oxlint's no-control-regex rejects it as a
// literal; build the pattern from its char code instead.
const NEWLINE = String.fromCharCode(10)
const BLANK_LINE_RUN = new RegExp(`${NEWLINE}{3,}`, 'g')

function collapseBlankLines(text: string): string {
  return text.replaceAll(BLANK_LINE_RUN, `${NEWLINE}${NEWLINE}`)
}

// The compaction block is the first turn of its window: it takes turn number 1
// and the window's relative-time origin (t="0"), so the body turns that follow
// it number from 2 and clock from the summary's timestamp. Detection already
// requires the marker on a user row, so the role is a fixed `user` rather than an
// interpolated field that could break out of the attribute.
function renderCompactionBlock(summary: MessageRow): string {
  const body = cleanSummaryBody(summary.content ?? '')
  return `<compaction n="1" role="user" t="0">\n${body}\n</compaction>`
}

function renderWindowBody(spec: WindowSpec): string {
  const lines: string[] = []
  const hasSummary = spec.summary !== null
  if (spec.summary !== null) {
    lines.push(renderCompactionBlock(spec.summary.row))
  }

  const anchorMs = spec.summary?.row.createdAt ?? null
  const turns = renderConversation(
    spec.bodyMessages,
    hermesRenderConfig,
    anchorMs,
    hasSummary ? 2 : 1,
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
    archived: spec.session.archived,
    startedAt,
    endedAt,
    // The compaction summary is the window's first (user) turn, so count it.
    turns:
      spec.bodyMessages.filter((m) => m.role === 'user').length +
      (spec.summary === null ? 0 : 1),
    tools: countTools(spec.bodyMessages),
    contextWindow: spec.contextWindow,
    platform: spec.session.platform,
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

function firstNonEmpty(values: readonly string[]): string {
  return values.find((v) => v.length > 0) ?? ''
}

function mergeSessions(raws: readonly unknown[]): MergedSession | null {
  const sessions = raws
    .map((raw) => sessionRowSchema.safeParse(raw))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
  const root = sessions[0]
  if (root === undefined) return null

  const platform: Frontmatter['platform'] = {}
  for (const session of sessions) {
    for (const [key, value] of Object.entries(
      scalarPlatformFields(session.platform),
    )) {
      if (!(key in platform)) platform[key] = value
    }
  }

  return {
    sessionId: root.sessionId,
    source: firstNonEmpty(sessions.map((s) => s.source ?? '')),
    title: firstNonEmpty(sessions.map((s) => s.title ?? '')),
    archived: sessions.some((s) => (s.archived ?? 0) > 0),
    platform,
  }
}

// Live message rows in order, each tagged with whether it opens a context
// window. Rewound rows (`active=0, compacted=0`) and `session_meta` rows
// never enter the stream, so they cannot start a window or skew a window's
// counts or time bounds. Compaction-archived rows (`active=0, compacted=1`)
// stay, so they render in their earlier window.
function collectEntries(raws: readonly unknown[]): MessageEntry[] {
  const out: MessageEntry[] = []
  for (const raw of raws) {
    if (isRewound(raw)) continue
    const parsed = messageRowSchema.safeParse(raw)
    if (!parsed.success) continue
    if (parsed.data.role === 'session_meta') continue
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
  const session = mergeSessions(raws)
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

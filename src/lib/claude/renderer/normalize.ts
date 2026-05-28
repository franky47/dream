import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  ToolPart,
  ToolResult,
} from '#lib/renderer/types'

import {
  type ClaudeEntry,
  entryText,
  parseEntries,
  toolResultContent,
} from './entries.ts'
import { stripFraming } from './framing.ts'
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

function entryTimestampMs(e: ClaudeEntry): number | null {
  if (e.timestamp === undefined) return null
  const ms = Date.parse(e.timestamp)
  return Number.isNaN(ms) ? null : ms
}

function collectResults(
  entries: readonly ClaudeEntry[],
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

function userParts(entry: ClaudeEntry): Part[] {
  const text = stripFraming(entryText(entry))
  return text.length === 0 ? [] : [{ kind: 'text', text }]
}

function assistantParts(
  entry: ClaudeEntry,
  results: ReadonlyMap<string, ToolResult>,
): Part[] {
  const content = entry.message?.content
  if (content === undefined) return []
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  const out: Part[] = []
  for (const c of content) {
    if (c.type === 'thinking') continue
    if (c.type === 'text' && 'text' in c) {
      out.push({ kind: 'text', text: c.text })
    } else if (c.type === 'tool_use') {
      const id = 'id' in c && c.id !== undefined ? c.id : ''
      const name = 'name' in c ? (c.name ?? 'unknown') : 'unknown'
      const input =
        'input' in c && c.input !== undefined
          ? (c.input as Record<string, unknown>)
          : {}
      const part: ToolPart = { kind: 'tool', id, name, input }
      if (id !== '') {
        const result = results.get(id)
        if (result !== undefined) part.result = result
      }
      out.push(part)
    }
  }
  return out
}

export function normalize(jsonlText: string): NormalizedSession {
  const entries = parseEntries(jsonlText)
  const frontmatterYaml = frontmatterToYaml(extractFrontmatter(jsonlText))
  const results = collectResults(entries)

  const messages: NormalizedMessage[] = []
  for (const e of entries) {
    if (DROPPED_ENTRY_TYPES.has(e.type)) continue
    if (e.type !== 'user' && e.type !== 'assistant') continue
    const role = e.type
    const timestampMs = entryTimestampMs(e)
    const parts = role === 'user' ? userParts(e) : assistantParts(e, results)
    messages.push({ role, timestampMs, parts })
  }
  return { frontmatterYaml, messages }
}

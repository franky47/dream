import type { NormalizedMessage, ToolPart } from '#lib/renderer/types'

import { editStats, type EditStats } from './tools.ts'

interface TodoItem {
  content: string
  status: string
}

export interface ClaudeState {
  readonly editStats: ReadonlyMap<string, EditStats>
  readonly editAbsorbed: ReadonlySet<string>
  lastTodos: TodoItem[] | null
}

function asFilePath(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function flattenToolParts(messages: readonly NormalizedMessage[]): ToolPart[] {
  const out: ToolPart[] = []
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'tool') out.push(p)
    }
  }
  return out
}

function computeEditGroups(tools: readonly ToolPart[]): {
  stats: Map<string, EditStats>
  absorbed: Set<string>
} {
  const stats = new Map<string, EditStats>()
  const absorbed = new Set<string>()
  let i = 0
  while (i < tools.length) {
    const u = tools[i]
    if (u === undefined || u.name !== 'Edit' || u.id === '') {
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
    while (j < tools.length) {
      const next = tools[j]
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
      if (next.id !== '') absorbed.add(next.id)
      j += 1
    }
    stats.set(u.id, { patches, added, removed })
    i = j
  }
  return { stats, absorbed }
}

export function claudePreprocess(
  messages: readonly NormalizedMessage[],
): ClaudeState {
  const tools = flattenToolParts(messages)
  const { stats, absorbed } = computeEditGroups(tools)
  return { editStats: stats, editAbsorbed: absorbed, lastTodos: null }
}

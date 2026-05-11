import path from 'node:path'

import { z } from 'zod'

const RENDERER_VERSION = 'claude-md@1'

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

const toolUsePartSchema = z.object({
  type: z.literal('tool_use'),
  name: z.string().optional(),
})

const toolResultPartSchema = z.object({
  type: z.literal('tool_result'),
})

const otherPartSchema = z.object({
  type: z.string(),
})

const partSchema = z.union([
  textPartSchema,
  toolUsePartSchema,
  toolResultPartSchema,
  otherPartSchema,
])

const messageSchema = z.object({
  role: z.string().optional(),
  content: z.union([z.string(), z.array(partSchema)]).optional(),
})

const baseEntrySchema = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  message: messageSchema.optional(),
  title: z.string().optional(),
})

type ClaudeEntry = z.infer<typeof baseEntrySchema>

const frontmatterSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  project: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  turns: z.number().int(),
  title: z.string(),
  toolUses: z.number().int(),
  renderer: z.string(),
})

export type Frontmatter = z.infer<typeof frontmatterSchema>

function parseEntries(jsonlText: string): ClaudeEntry[] {
  const out: ClaudeEntry[] = []
  for (const raw of jsonlText.split('\n')) {
    if (raw.length === 0) continue
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      continue
    }
    const parsed = baseEntrySchema.safeParse(json)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

const FRAMING_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
] as const

function stripFraming(text: string): string {
  let out = text
  for (const tag of FRAMING_TAGS) {
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'g')
    out = out.replace(re, '')
  }
  return out.trim()
}

function entryText(entry: ClaudeEntry): string {
  const content = entry.message?.content
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const c of content) {
    if (c.type === 'text' && 'text' in c) parts.push(c.text)
  }
  return parts.join('\n')
}

function countToolUses(entry: ClaudeEntry): number {
  const content = entry.message?.content
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const c of content) {
    if (c.type === 'tool_use') n += 1
  }
  return n
}

function firstUserTitle(entries: ReadonlyArray<ClaudeEntry>): string | null {
  for (const e of entries) {
    if (e.type !== 'user') continue
    const stripped = stripFraming(entryText(e))
    if (stripped.length === 0) continue
    return stripped.length > 80 ? stripped.slice(0, 80) : stripped
  }
  return null
}

export function extractFrontmatter(jsonlText: string): Frontmatter {
  const entries = parseEntries(jsonlText)

  const sessionId = entries.find((e) => e.sessionId)?.sessionId ?? ''
  const cwd = entries.find((e) => e.cwd)?.cwd ?? ''
  const project = cwd ? path.basename(cwd) : ''

  const stamped = entries.filter((e) => e.timestamp)
  const startedAt = stamped[0]?.timestamp ?? ''
  const endedAt = stamped[stamped.length - 1]?.timestamp ?? ''

  const turns = entries.filter((e) => e.type === 'user').length
  const toolUses = entries.reduce((acc, e) => acc + countToolUses(e), 0)

  const aiTitle = entries.find((e) => e.type === 'ai-title')?.title
  const title = aiTitle ?? firstUserTitle(entries) ?? '(untitled)'

  return {
    sessionId,
    cwd,
    project,
    startedAt,
    endedAt,
    turns,
    title,
    toolUses,
    renderer: RENDERER_VERSION,
  }
}

function yamlEscapeString(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function frontmatterToYaml(fm: Frontmatter): string {
  const lines: string[] = ['---']
  lines.push(`sessionId: ${fm.sessionId}`)
  lines.push(`cwd: ${yamlEscapeString(fm.cwd)}`)
  lines.push(`project: ${yamlEscapeString(fm.project)}`)
  lines.push(`startedAt: ${fm.startedAt}`)
  lines.push(`endedAt: ${fm.endedAt}`)
  lines.push(`turns: ${fm.turns}`)
  lines.push(`title: ${yamlEscapeString(fm.title)}`)
  lines.push(`toolUses: ${fm.toolUses}`)
  lines.push(`renderer: ${yamlEscapeString(fm.renderer)}`)
  lines.push('---')
  return lines.join('\n') + '\n'
}

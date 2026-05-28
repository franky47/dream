import path from 'node:path'

import { z } from 'zod'

const RENDERER_VERSION = 'opencode-md@1'

const frontmatterSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  project: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  turns: z.number().int(),
  title: z.string(),
  toolUses: z.number().int(),
  providerID: z.string(),
  modelID: z.string(),
  agent: z.string(),
  renderer: z.string(),
})

export type Frontmatter = z.infer<typeof frontmatterSchema>

const sessionRowSchema = z.object({
  type: z.literal('session'),
  sessionId: z.string(),
  title: z.string(),
  directory: z.string(),
  project: z
    .object({
      worktree: z.string(),
      name: z.string().nullable(),
    })
    .optional(),
})

const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  time: z.object({ created: z.number() }),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  agent: z.string().optional(),
})

const partRowSchema = z.object({
  type: z.literal('part'),
  partType: z.string(),
})

type SessionRow = z.infer<typeof sessionRowSchema>
type MessageRow = z.infer<typeof messageRowSchema>

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

function projectName(session: SessionRow): string {
  const named = session.project?.name
  if (named !== undefined && named !== null && named.length > 0) return named
  const worktree = session.project?.worktree
  if (worktree !== undefined && worktree.length > 0)
    return path.basename(worktree)
  return ''
}

export function extractFrontmatter(jsonlText: string): Frontmatter {
  const raws = parseRows(jsonlText)

  let session: SessionRow | null = null
  const messages: MessageRow[] = []
  let toolUses = 0
  let firstAssistant: MessageRow | null = null
  let firstAgent: string | null = null

  for (const raw of raws) {
    const sess = sessionRowSchema.safeParse(raw)
    if (sess.success) {
      session ??= sess.data
      continue
    }
    const msg = messageRowSchema.safeParse(raw)
    if (msg.success) {
      messages.push(msg.data)
      if (msg.data.role === 'assistant' && firstAssistant === null) {
        firstAssistant = msg.data
      }
      if (firstAgent === null && msg.data.agent !== undefined) {
        firstAgent = msg.data.agent
      }
      continue
    }
    const part = partRowSchema.safeParse(raw)
    if (part.success && part.data.partType === 'tool') toolUses += 1
  }

  const stamped = messages.filter((m) => Number.isFinite(m.time.created))
  const startedAt =
    stamped.length > 0 ? new Date(stamped[0]!.time.created).toISOString() : ''
  const endedAt =
    stamped.length > 0
      ? new Date(stamped[stamped.length - 1]!.time.created).toISOString()
      : ''

  return {
    sessionId: session?.sessionId ?? '',
    cwd: session?.directory ?? '',
    project: session === null ? '' : projectName(session),
    startedAt,
    endedAt,
    turns: messages.filter((m) => m.role === 'user').length,
    title: session?.title ?? '',
    toolUses,
    providerID: firstAssistant?.providerID ?? '',
    modelID: firstAssistant?.modelID ?? '',
    agent: firstAgent ?? '',
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
  lines.push(`providerID: ${yamlEscapeString(fm.providerID)}`)
  lines.push(`modelID: ${yamlEscapeString(fm.modelID)}`)
  lines.push(`agent: ${yamlEscapeString(fm.agent)}`)
  lines.push(`renderer: ${yamlEscapeString(fm.renderer)}`)
  lines.push('---')
  return lines.join('\n') + '\n'
}

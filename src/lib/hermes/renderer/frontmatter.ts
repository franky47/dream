import { z } from 'zod'

const RENDERER_VERSION = 'hermes-md@1'

// Platform origin travels as a nested object on the session row. Keep the parse
// permissive: read whatever scalar fields a platform provides (channel, thread,
// guild, author IDs and their human-readable labels) and ignore nested shapes,
// so one odd field never drops the whole block.
const platformFieldSchema = z.union([z.string(), z.number(), z.boolean()])

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
  role: z.string(),
  createdAt: z.number(),
})

type SessionRow = z.infer<typeof sessionRowSchema>
type MessageRow = z.infer<typeof messageRowSchema>

type PlatformField = z.infer<typeof platformFieldSchema>

export interface Frontmatter {
  sessionId: string
  source: string
  title: string
  archived: boolean
  startedAt: string
  endedAt: string
  turns: number
  platform: Record<string, PlatformField>
  renderer: string
}

function scalarPlatformFields(
  platform: unknown,
): Record<string, PlatformField> {
  const out: Record<string, PlatformField> = {}
  if (
    platform == null ||
    typeof platform !== 'object' ||
    Array.isArray(platform)
  )
    return out
  for (const [key, value] of Object.entries(platform)) {
    const field = platformFieldSchema.safeParse(value)
    if (field.success) out[key] = field.data
  }
  return out
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

export function extractFrontmatter(jsonlText: string): Frontmatter {
  const raws = parseRows(jsonlText)

  let session: SessionRow | null = null
  const messages: MessageRow[] = []

  for (const raw of raws) {
    const sess = sessionRowSchema.safeParse(raw)
    if (sess.success) {
      session ??= sess.data
      continue
    }
    const msg = messageRowSchema.safeParse(raw)
    if (msg.success) messages.push(msg.data)
  }

  const stamped = messages.filter((m) => Number.isFinite(m.createdAt))
  const startedAt =
    stamped.length > 0 ? new Date(stamped[0]!.createdAt).toISOString() : ''
  const endedAt =
    stamped.length > 0
      ? new Date(stamped[stamped.length - 1]!.createdAt).toISOString()
      : ''

  return {
    sessionId: session?.sessionId ?? '',
    source: session?.source ?? '',
    title: session?.title ?? '',
    archived: (session?.archived ?? 0) > 0,
    startedAt,
    endedAt,
    turns: messages.filter((m) => m.role === 'user').length,
    platform: scalarPlatformFields(session?.platform),
    renderer: RENDERER_VERSION,
  }
}

function yamlEscapeString(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function yamlScalar(value: PlatformField): string {
  return typeof value === 'string' ? yamlEscapeString(value) : String(value)
}

export function frontmatterToYaml(fm: Frontmatter): string {
  const lines: string[] = ['---']
  lines.push(`sessionId: ${fm.sessionId}`)
  lines.push(`source: ${yamlEscapeString(fm.source)}`)
  lines.push(`title: ${yamlEscapeString(fm.title)}`)
  // Only archived sessions carry the flag; its absence means "not archived", so
  // a live session's frontmatter stays free of a redundant `archived: false`.
  if (fm.archived) lines.push('archived: true')
  lines.push(`startedAt: ${fm.startedAt}`)
  lines.push(`endedAt: ${fm.endedAt}`)
  lines.push(`turns: ${fm.turns}`)
  const platformKeys = Object.keys(fm.platform).sort()
  if (platformKeys.length > 0) {
    lines.push('platform:')
    for (const key of platformKeys) {
      lines.push(`  ${key}: ${yamlScalar(fm.platform[key]!)}`)
    }
  }
  lines.push(`renderer: ${yamlEscapeString(fm.renderer)}`)
  lines.push('---')
  return lines.join('\n') + '\n'
}

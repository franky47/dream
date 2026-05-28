import { z } from 'zod'

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

const toolUsePartSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
})

const thinkingPartSchema = z.object({
  type: z.literal('thinking'),
})

const toolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().optional(),
  content: z
    .union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ])
    .optional(),
  is_error: z.boolean().optional(),
})

const otherPartSchema = z.object({
  type: z.string(),
})

const partSchema = z.union([
  textPartSchema,
  toolUsePartSchema,
  thinkingPartSchema,
  toolResultPartSchema,
  otherPartSchema,
])

export type ContentPart = z.infer<typeof partSchema>

const messageSchema = z.object({
  role: z.string().optional(),
  content: z.union([z.string(), z.array(partSchema)]).optional(),
})

const entrySchema = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  message: messageSchema.optional(),
  title: z.string().optional(),
})

export type ClaudeEntry = z.infer<typeof entrySchema>

export function parseEntries(jsonlText: string): ClaudeEntry[] {
  const out: ClaudeEntry[] = []
  for (const raw of jsonlText.split('\n')) {
    if (raw.length === 0) continue
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      continue
    }
    const parsed = entrySchema.safeParse(json)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

export function entryText(entry: ClaudeEntry): string {
  const content = entry.message?.content
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const c of content) {
    if (c.type === 'text' && 'text' in c) parts.push(c.text)
  }
  return parts.join('\n')
}

export function toolResultContent(part: ContentPart): string {
  if (part.type !== 'tool_result') return ''
  if (!('content' in part) || part.content === undefined) return ''
  if (typeof part.content === 'string') return part.content
  const out: string[] = []
  for (const c of part.content) {
    if (c.type === 'text' && c.text !== undefined) out.push(c.text)
  }
  return out.join('\n')
}

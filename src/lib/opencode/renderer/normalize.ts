import { z } from 'zod'

import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  Role,
  ToolPart,
  ToolResult,
} from '#lib/renderer/types'

import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

const messageRowSchema = z.object({
  type: z.literal('message'),
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  time: z.object({ created: z.number() }),
})

const textPartSchema = z.object({
  type: z.literal('part'),
  id: z.string(),
  messageId: z.string(),
  partType: z.literal('text'),
  text: z.string(),
})

const toolPartSchema = z.object({
  type: z.literal('part'),
  id: z.string(),
  messageId: z.string(),
  partType: z.literal('tool'),
  tool: z.string(),
  callID: z.string(),
  state: z.object({
    status: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
})

type MessageRow = z.infer<typeof messageRowSchema>

function parseLines(jsonlText: string): unknown[] {
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

function toolResultFor(
  state: z.infer<typeof toolPartSchema>['state'],
): ToolResult | undefined {
  if (state.status === 'completed') {
    return { content: coerceOutput(state.output), isError: false }
  }
  if (state.status === 'error') {
    const content =
      state.output !== undefined
        ? coerceOutput(state.output)
        : (state.error ?? '')
    return { content, isError: true }
  }
  return undefined
}

function coerceOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return ''
  return JSON.stringify(output)
}

function toToolPart(parsed: z.infer<typeof toolPartSchema>): ToolPart {
  const part: ToolPart = {
    kind: 'tool',
    id: parsed.callID,
    name: parsed.tool,
    input: parsed.state.input ?? {},
  }
  const result = toolResultFor(parsed.state)
  if (result !== undefined) part.result = result
  return part
}

function partsFor(
  messageId: string,
  partsByMessageId: ReadonlyMap<string, Part[]>,
): Part[] {
  return partsByMessageId.get(messageId) ?? []
}

export function normalize(jsonlText: string): NormalizedSession {
  const raws = parseLines(jsonlText)
  const frontmatterYaml = frontmatterToYaml(extractFrontmatter(jsonlText))

  const messagesOrdered: MessageRow[] = []
  const partsByMessageId = new Map<string, Part[]>()

  for (const raw of raws) {
    const msg = messageRowSchema.safeParse(raw)
    if (msg.success) {
      messagesOrdered.push(msg.data)
      continue
    }
    const text = textPartSchema.safeParse(raw)
    if (text.success) {
      const part: Part = { kind: 'text', text: text.data.text }
      pushPart(partsByMessageId, text.data.messageId, part)
      continue
    }
    const tool = toolPartSchema.safeParse(raw)
    if (tool.success) {
      pushPart(partsByMessageId, tool.data.messageId, toToolPart(tool.data))
    }
  }

  const messages: NormalizedMessage[] = messagesOrdered.map((m) => ({
    role: m.role satisfies Role,
    timestampMs: m.time.created,
    parts: partsFor(m.id, partsByMessageId),
  }))

  return { frontmatterYaml, messages }
}

function pushPart(
  map: Map<string, Part[]>,
  messageId: string,
  part: Part,
): void {
  const existing = map.get(messageId)
  if (existing === undefined) map.set(messageId, [part])
  else existing.push(part)
}

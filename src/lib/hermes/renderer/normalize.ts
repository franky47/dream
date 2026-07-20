import { z } from 'zod'

import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  Role,
  ToolPart,
} from '#lib/renderer/types'

import { stripDiscordTriggerNote } from './discord.ts'
import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'
import { isRewound } from './rewound.ts'

const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.string(),
  content: z.string(),
  createdAt: z.number(),
})

// Hermes wraps OpenAI Codex and stores each tool execution as its own message
// row: a call row followed later by its result row. The two share a call id, so
// the renderer pairs them into one tool part without reordering the transcript.
const toolCallContentSchema = z.object({
  type: z.literal('tool_call'),
  callId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
})

const toolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  callId: z.string(),
  output: z.string().optional(),
  isError: z.boolean().optional(),
  details: z.unknown().optional(),
})

type ToolCallContent = z.infer<typeof toolCallContentSchema>
type ToolResultContent = z.infer<typeof toolResultContentSchema>

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

function parseContentItem(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

function toRole(role: string): Role {
  return role === 'user' ? 'user' : 'assistant'
}

const envelopeTypeSchema = z.object({
  type: z.enum(['tool_call', 'tool_result']),
})

// A row that announces itself as a tool envelope but fails full validation is
// dropped, never leaked as text: with the tool field keys modeled on Codex, a
// mismatch should degrade to a missing tool row rather than raw JSON prose.
function isToolEnvelope(item: unknown): boolean {
  return envelopeTypeSchema.safeParse(item).success
}

export function normalize(jsonlText: string): NormalizedSession {
  const raws = parseLines(jsonlText)
  const frontmatterYaml = frontmatterToYaml(extractFrontmatter(jsonlText))

  const messages: NormalizedMessage[] = []
<<<<<<< HEAD
  const pending = new Map<string, ToolPart>()
  let currentAssistant: NormalizedMessage | null = null

  const ensureAssistant = (timestampMs: number): NormalizedMessage => {
    if (currentAssistant !== null) return currentAssistant
    const m: NormalizedMessage = { role: 'assistant', timestampMs, parts: [] }
    messages.push(m)
    currentAssistant = m
    return m
  }

  const addToolCall = (call: ToolCallContent, timestampMs: number): void => {
    const part: ToolPart = {
      kind: 'tool',
      id: call.callId,
      name: call.name,
      input: call.input ?? {},
    }
    ensureAssistant(timestampMs).parts.push(part)
    pending.set(call.callId, part)
  }

  const attachToolResult = (result: ToolResultContent): void => {
    const part = pending.get(result.callId)
    if (part === undefined) return
    part.result = {
      content: result.output ?? '',
      isError: result.isError ?? false,
      details: result.details,
    }
  }

  const addText = (role: Role, content: string, timestampMs: number): void => {
    currentAssistant = null
    const parts: Part[] =
      content.length > 0 ? [{ kind: 'text', text: content }] : []
    const m: NormalizedMessage = { role, timestampMs, parts }
    messages.push(m)
    if (role === 'assistant') currentAssistant = m
  }

  for (const raw of raws) {
    if (isRewound(raw)) continue
    const parsed = messageRowSchema.safeParse(raw)
    if (!parsed.success) continue
    const { role, content, createdAt } = parsed.data

    const item = parseContentItem(content)
    const call = toolCallContentSchema.safeParse(item)
    if (call.success) {
      addToolCall(call.data, createdAt)
      continue
    }
    const result = toolResultContentSchema.safeParse(item)
    if (result.success) {
      attachToolResult(result.data)
      continue
    }
    if (isToolEnvelope(item)) continue

    const normalizedRole = toRole(role)
    const text =
      normalizedRole === 'user' ? stripDiscordTriggerNote(content) : content
    addText(normalizedRole, text, createdAt)
  }

  return { frontmatterYaml, messages }
}

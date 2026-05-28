import { z } from 'zod'

import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  ToolPart,
  ToolResult,
} from '#lib/renderer/types'

import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

const wrapperSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  payload: z.unknown(),
})

const messagePayloadSchema = z.object({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'developer']),
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
})

const functionCallSchema = z.object({
  type: z.literal('function_call'),
  name: z.string(),
  call_id: z.string(),
  arguments: z.string(),
})

const functionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.string(),
})

const customToolCallSchema = z.object({
  type: z.literal('custom_tool_call'),
  name: z.string(),
  call_id: z.string(),
  input: z.string(),
})

const customToolCallOutputSchema = z.object({
  type: z.literal('custom_tool_call_output'),
  call_id: z.string(),
  output: z.string(),
})

const reasoningSchema = z.object({
  type: z.literal('reasoning'),
  summary: z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
  content: z
    .array(
      z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
    )
    .nullable(),
})

const mcpToolCallEndSchema = z.object({
  type: z.literal('mcp_tool_call_end'),
  call_id: z.string(),
  result: z.unknown(),
})

interface Wrapper {
  timestamp: string
  type: string
  payload: unknown
}

interface PendingToolCall {
  part: ToolPart
  isMcp: boolean
  messageIndex: number
}

function parseLines(jsonlText: string): Wrapper[] {
  const out: Wrapper[] = []
  for (const line of jsonlText.split('\n')) {
    if (line.length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = wrapperSchema.safeParse(raw)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

const argumentsObjectSchema = z.record(z.string(), z.unknown())

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    const obj = argumentsObjectSchema.safeParse(parsed)
    if (obj.success) return obj.data
  } catch {
    /* fall through */
  }
  return { _raw: raw }
}

function joinTexts(items: ReadonlyArray<{ text?: string }>): string {
  return items
    .map((c) => c.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('\n')
}

function isReasoningEmpty(r: z.infer<typeof reasoningSchema>): boolean {
  return r.summary.length === 0 && r.content === null
}

export function normalize(jsonlText: string): NormalizedSession {
  const wrappers = parseLines(jsonlText)
  const frontmatterYaml = frontmatterToYaml(extractFrontmatter(jsonlText))

  const messages: NormalizedMessage[] = []
  const pending = new Map<string, PendingToolCall>()
  let currentAssistant: NormalizedMessage | null = null

  const ensureAssistant = (timestampMs: number | null): NormalizedMessage => {
    if (currentAssistant !== null) return currentAssistant
    const m: NormalizedMessage = { role: 'assistant', timestampMs, parts: [] }
    messages.push(m)
    currentAssistant = m
    return m
  }

  const flushAssistant = (): void => {
    currentAssistant = null
  }

  for (const w of wrappers) {
    const ts = Date.parse(w.timestamp)
    const timestampMs = Number.isNaN(ts) ? null : ts

    if (w.type === 'session_meta' || w.type === 'turn_context') continue

    if (w.type === 'event_msg') {
      const mcp = mcpToolCallEndSchema.safeParse(w.payload)
      if (mcp.success) {
        const p = pending.get(mcp.data.call_id)
        if (p !== undefined && p.isMcp) {
          p.part.result = {
            content: JSON.stringify(mcp.data.result),
            isError: false,
          }
        }
      }
      continue
    }

    if (w.type !== 'response_item') continue

    const msg = messagePayloadSchema.safeParse(w.payload)
    if (msg.success) {
      flushAssistant()
      const role = msg.data.role === 'assistant' ? 'assistant' : 'user'
      const text = joinTexts(msg.data.content)
      const parts: Part[] = text.length > 0 ? [{ kind: 'text', text }] : []
      const m: NormalizedMessage = { role, timestampMs, parts }
      messages.push(m)
      if (role === 'assistant') currentAssistant = m
      continue
    }

    const fc = functionCallSchema.safeParse(w.payload)
    if (fc.success) {
      const target = ensureAssistant(timestampMs)
      const isMcp = fc.data.name.startsWith('mcp__')
      const part: ToolPart = {
        kind: 'tool',
        id: fc.data.call_id,
        name: fc.data.name,
        input: parseArguments(fc.data.arguments),
      }
      target.parts.push(part)
      pending.set(fc.data.call_id, {
        part,
        isMcp,
        messageIndex: messages.length - 1,
      })
      continue
    }

    const fout = functionCallOutputSchema.safeParse(w.payload)
    if (fout.success) {
      const p = pending.get(fout.data.call_id)
      if (p === undefined) continue
      if (p.isMcp && p.part.result !== undefined) continue
      const result: ToolResult = { content: fout.data.output, isError: false }
      p.part.result = result
      continue
    }

    const cc = customToolCallSchema.safeParse(w.payload)
    if (cc.success) {
      const target = ensureAssistant(timestampMs)
      const part: ToolPart = {
        kind: 'tool',
        id: cc.data.call_id,
        name: cc.data.name,
        input: { _raw: cc.data.input },
      }
      target.parts.push(part)
      pending.set(cc.data.call_id, {
        part,
        isMcp: false,
        messageIndex: messages.length - 1,
      })
      continue
    }

    const cout = customToolCallOutputSchema.safeParse(w.payload)
    if (cout.success) {
      const p = pending.get(cout.data.call_id)
      if (p === undefined) continue
      p.part.result = { content: cout.data.output, isError: false }
      continue
    }

    const reasoning = reasoningSchema.safeParse(w.payload)
    if (reasoning.success && !isReasoningEmpty(reasoning.data)) {
      const target = ensureAssistant(timestampMs)
      const summary = joinTexts(reasoning.data.summary)
      const content =
        reasoning.data.content === null ? '' : joinTexts(reasoning.data.content)
      const text = [summary, content].filter((s) => s.length > 0).join('\n')
      if (text.length > 0) target.parts.push({ kind: 'text', text })
    }
  }

  return { frontmatterYaml, messages }
}

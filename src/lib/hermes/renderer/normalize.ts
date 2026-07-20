import { z } from 'zod'

import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  Role,
  ToolPart,
  ToolResult,
} from '#lib/renderer/types'

import { stripDiscordTriggerNote } from './discord.ts'
import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'
import { isRewound } from './rewound.ts'

// Hermes stores each assistant turn's tool invocations inline as a `tool_calls`
// JSON array in the OpenAI function-call shape, and each tool's result as a
// later `role='tool'` row keyed by `tool_call_id`. The schemas stay permissive:
// a single odd entry should degrade to a missing field, never drop the row.
const toolFunctionSchema = z.object({
  name: z.string().optional(),
  arguments: z.string().optional(),
})

const toolCallSchema = z.object({
  id: z.string().optional(),
  call_id: z.string().optional(),
  type: z.string().optional(),
  function: toolFunctionSchema.optional(),
})

const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.string(),
  content: z.string().nullish(),
  createdAt: z.number(),
  toolCalls: z.array(toolCallSchema).nullish(),
  toolCallId: z.string().nullish(),
  toolName: z.string().nullish(),
})

type MessageRow = z.infer<typeof messageRowSchema>

// A tool result row carries a JSON object such as `{"output":"..."}` or
// `{"success":true,...}`. Read `output` when present; otherwise keep the whole
// object so nothing is lost. `success:false` marks the call as failed.
const resultObjectSchema = z
  .object({
    output: z.string().optional(),
    success: z.boolean().optional(),
  })
  .loose()

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

function toRole(role: string): Role {
  return role === 'user' ? 'user' : 'assistant'
}

function parseArguments(fn: z.infer<typeof toolFunctionSchema> | undefined): {
  [key: string]: unknown
} {
  if (fn?.arguments === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fn.arguments)
  } catch {
    return {}
  }
  const record = z.record(z.string(), z.unknown()).safeParse(parsed)
  return record.success ? record.data : {}
}

function toToolPart(call: z.infer<typeof toolCallSchema>): ToolPart | null {
  const id = call.call_id ?? call.id
  const name = call.function?.name
  if (id === undefined || name === undefined) return null
  return { kind: 'tool', id, name, input: parseArguments(call.function) }
}

function toToolResult(content: string): ToolResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { content, isError: false }
  }
  const object = resultObjectSchema.safeParse(parsed)
  if (!object.success) return { content, isError: false }
  const output = object.data.output ?? JSON.stringify(parsed)
  return {
    content: output,
    isError: object.data.success === false,
    details: parsed,
  }
}

export function normalize(jsonlText: string): NormalizedSession {
  const raws = parseLines(jsonlText)
  const frontmatterYaml = frontmatterToYaml(extractFrontmatter(jsonlText))
  return { frontmatterYaml, messages: normalizeMessages(raws) }
}

// Folds Hermes message rows into an ordered stream. An assistant row becomes one
// message carrying its text and any inline tool calls; a `role='tool'` row
// attaches its result to the pending call by id. The fragment renderer feeds
// each context window through this same seam, so every path shares one
// tool-pairing, Discord-stripping and rewound-skipping rule.
export function normalizeMessages(
  raws: readonly unknown[],
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = []
  const pending = new Map<string, ToolPart>()

  const attachResult = (row: MessageRow): void => {
    if (row.toolCallId == null || row.content == null) return
    const part = pending.get(row.toolCallId)
    if (part === undefined) return
    part.result = toToolResult(row.content)
  }

  const addRow = (role: Role, row: MessageRow): void => {
    const rawText = row.content ?? ''
    const text = role === 'user' ? stripDiscordTriggerNote(rawText) : rawText
    const parts: Part[] = []
    if (text.length > 0) parts.push({ kind: 'text', text })
    for (const call of row.toolCalls ?? []) {
      const part = toToolPart(call)
      if (part === null) continue
      parts.push(part)
      pending.set(part.id, part)
    }
    if (parts.length === 0) return
    messages.push({ role, timestampMs: row.createdAt, parts })
  }

  for (const raw of raws) {
    const parsed = messageRowSchema.safeParse(raw)
    if (!parsed.success) continue
    const row = parsed.data
    if (row.role === 'session_meta') continue
    if (isRewound(raw)) continue

    if (row.role === 'tool') {
      attachResult(row)
      continue
    }
    addRow(toRole(row.role), row)
  }

  return messages
}

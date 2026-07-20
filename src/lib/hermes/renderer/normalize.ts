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
  // Each element is re-parsed with `toolCallSchema` in `addRow`, so a single
  // malformed entry degrades to a missing call rather than failing the whole
  // array and dropping the assistant row (including its text) with it.
  toolCalls: z.array(z.unknown()).nullish(),
  toolCallId: z.string().nullish(),
  toolName: z.string().nullish(),
  apiContent: z.string().nullish(),
})

type MessageRow = z.infer<typeof messageRowSchema>

// A tool result row carries a JSON object. A terminal run stores
// `{output, exit_code, error}` (extra keys such as `approval` may ride along);
// other tools store their own scalar keys. Read `output` when present; otherwise
// keep the whole object so nothing is lost. A run failed when its `exit_code` is
// non-zero or its `error` field is truthy (a non-empty error string or an error
// object) — the old `success:false` flag never appears on real rows. `exit_code`
// is coerced so a stringified code still reads as a number, and `error` stays
// `unknown` so an object-shaped failure is not dropped as a schema mismatch.
const resultObjectSchema = z
  .object({
    output: z.string().optional(),
    exit_code: z.coerce.number().optional(),
    error: z.unknown().optional(),
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

// Only the two conversational roles render as turns. An unknown role (a
// `system` row, say) is skipped rather than silently coerced to `assistant`,
// which would mislabel it.
function toRole(role: string): Role | null {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return null
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

function isResultFailure(data: z.infer<typeof resultObjectSchema>): boolean {
  const failedExit = data.exit_code !== undefined && data.exit_code !== 0
  // A real success row carries `error: null` or an empty string, both falsy; a
  // non-empty error string or an error object is a failure.
  const hasError = Boolean(data.error)
  return failedExit || hasError
}

function toToolResult(content: string): ToolResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // Empty output is "no output", not a failure. A non-empty payload that is
    // not the JSON success envelope has an unknown status, so surface it as a
    // non-success rather than letting a failure such as `Error: timed out`
    // render as a clean success.
    return { content, isError: content.trim().length > 0 }
  }
  const object = resultObjectSchema.safeParse(parsed)
  if (!object.success) return { content, isError: false }
  const output = object.data.output ?? JSON.stringify(parsed)
  return {
    content: output,
    isError: isResultFailure(object.data),
    details: parsed,
  }
}

// A projected tool-result row usually carries its payload in `content`. When
// `content` is null the payload may live in the projected `apiContent` field, but
// only a value that parses to a JSON object (the verified result envelope) is
// treated as a result; anything else keeps dropping.
function resolveResultPayload(row: MessageRow): string | null {
  if (row.content != null) return row.content
  if (row.apiContent == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.apiContent)
  } catch {
    return null
  }
  const isPlainObject =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  return isPlainObject ? row.apiContent : null
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
    if (row.toolCallId == null) return
    const part = pending.get(row.toolCallId)
    if (part === undefined) return
    const payload = resolveResultPayload(row)
    if (payload === null) return
    part.result = toToolResult(payload)
  }

  const addRow = (role: Role, row: MessageRow): void => {
    const rawText = row.content ?? ''
    const text = role === 'user' ? stripDiscordTriggerNote(rawText) : rawText
    const parts: Part[] = []
    if (text.length > 0) parts.push({ kind: 'text', text })
    for (const rawCall of row.toolCalls ?? []) {
      const parsedCall = toolCallSchema.safeParse(rawCall)
      if (!parsedCall.success) continue
      const part = toToolPart(parsedCall.data)
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
    const role = toRole(row.role)
    if (role === null) continue
    addRow(role, row)
  }

  return messages
}

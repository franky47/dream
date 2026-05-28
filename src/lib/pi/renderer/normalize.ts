import { z } from 'zod'

import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  Role,
  ToolPart,
  ToolResult,
} from '#lib/renderer/types'

import { activePath, type Node, parseTree, type PiTree } from './entries.ts'
import { buildFrontmatter, frontmatterToYaml } from './frontmatter.ts'

const argumentsObjectSchema = z.record(z.string(), z.unknown())

const contentItemSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: argumentsObjectSchema.optional(),
  })
  .passthrough()

const messageBodySchema = z.object({
  role: z.string(),
  content: z.array(contentItemSchema).optional(),
})

const userOrAssistantSchema = z.object({
  type: z.literal('message'),
  message: messageBodySchema,
})

const toolResultBodySchema = z.object({
  role: z.literal('toolResult'),
  toolCallId: z.string(),
  toolName: z.string().optional(),
  content: z.array(contentItemSchema).optional(),
  details: z.unknown().optional(),
})

const toolResultPayloadSchema = z.object({
  type: z.literal('message'),
  message: toolResultBodySchema,
})

const bashExecBodySchema = z.object({
  role: z.literal('bashExecution'),
  command: z.string(),
  output: z.string(),
  exitCode: z.number(),
  cancelled: z.boolean().optional(),
  truncated: z.boolean().optional(),
  excludeFromContext: z.boolean().optional(),
})

const bashExecPayloadSchema = z.object({
  type: z.literal('message'),
  message: bashExecBodySchema,
})

const customMessageSchema = z
  .object({
    type: z.literal('custom_message'),
    customType: z.string(),
  })
  .passthrough()

function joinText(
  items: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return items
    .filter((c) => c.type === 'text' || c.type === 'output_text')
    .map((c) => c.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('\n')
}

interface PendingToolCall {
  part: ToolPart
}

export function normalize(jsonlText: string): NormalizedSession {
  return normalizeTree(parseTree(jsonlText))
}

export function normalizeTree(tree: PiTree): NormalizedSession {
  const path = activePath(tree)
  const frontmatterYaml = frontmatterToYaml(buildFrontmatter(tree))

  const messages: NormalizedMessage[] = []
  const pending = new Map<string, PendingToolCall>()

  for (const node of path) {
    if (node.type === 'custom') continue
    if (node.type === 'model_change') continue
    if (node.type === 'thinking_level_change') continue
    if (node.type === 'session_info') continue
    if (node.type === 'label') continue
    if (node.type === 'branch_summary') continue
    if (node.type === 'compaction') continue

    const ts = Date.parse(node.timestamp)
    const timestampMs = Number.isNaN(ts) ? null : ts

    const cm = customMessageSchema.safeParse(node)
    if (cm.success) {
      const part: ToolPart = {
        kind: 'tool',
        id: node.id,
        name: cm.data.customType,
        input: collectCustomMessageInput(node),
      }
      messages.push({ role: 'user', timestampMs, parts: [part] })
      continue
    }

    const bash = bashExecPayloadSchema.safeParse(node)
    if (bash.success) {
      const part: ToolPart = {
        kind: 'tool',
        id: node.id,
        name: 'bashExecution',
        input: {
          command: bash.data.message.command,
          exitCode: bash.data.message.exitCode,
          excludeFromContext: bash.data.message.excludeFromContext ?? false,
        },
        result: {
          content: bash.data.message.output,
          isError: bash.data.message.exitCode !== 0,
        },
      }
      messages.push({ role: 'user', timestampMs, parts: [part] })
      continue
    }

    const tr = toolResultPayloadSchema.safeParse(node)
    if (tr.success) {
      const target = pending.get(tr.data.message.toolCallId)
      if (target === undefined) continue
      const content = joinText(tr.data.message.content ?? [])
      target.part.result = { content, isError: false } satisfies ToolResult
      continue
    }

    const msg = userOrAssistantSchema.safeParse(node)
    if (!msg.success) continue
    const role = mapRole(msg.data.message.role)
    if (role === null) continue
    const parts = buildParts(msg.data.message.content ?? [], pending)
    messages.push({ role, timestampMs, parts })
  }

  return { frontmatterYaml, messages }
}

function mapRole(role: string): Role | null {
  if (role === 'user' || role === 'assistant') return role
  return null
}

function buildParts(
  content: ReadonlyArray<z.infer<typeof contentItemSchema>>,
  pending: Map<string, PendingToolCall>,
): Part[] {
  const parts: Part[] = []
  const text = joinText(content)
  if (text.length > 0) parts.push({ kind: 'text', text })

  for (const c of content) {
    if (
      c.type === 'toolCall' &&
      typeof c.id === 'string' &&
      typeof c.name === 'string'
    ) {
      const part: ToolPart = {
        kind: 'tool',
        id: c.id,
        name: c.name,
        input: c.arguments ?? {},
      }
      parts.push(part)
      pending.set(c.id, { part })
    }
  }
  return parts
}

function collectCustomMessageInput(node: Node): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'id' || k === 'parentId' || k === 'timestamp') {
      continue
    }
    if (k === 'customType') continue
    out[k] = v
  }
  return out
}

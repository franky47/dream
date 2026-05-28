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

const compactionSchema = z.object({
  type: z.literal('compaction'),
  id: z.string(),
  timestamp: z.string(),
  firstKeptEntryId: z.string(),
  summary: z.string(),
  tokensBefore: z.number().optional(),
})

const modelChangeSchema = z.object({
  type: z.literal('model_change'),
  provider: z.string(),
  modelId: z.string(),
})

const thinkingLevelChangeSchema = z.object({
  type: z.literal('thinking_level_change'),
  thinkingLevel: z.string(),
})

const branchSummarySchema = z.object({
  type: z.literal('branch_summary'),
  summary: z.string(),
})

const labelSchema = z.object({
  type: z.literal('label'),
  targetId: z.string(),
  label: z.string(),
})

interface CompactionCut {
  cutIndex: number
  summary: string
  tokensBefore: number | null
  timestamp: string
}

function findCompactionCut(path: readonly Node[]): CompactionCut | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const node = path[i]
    if (node === undefined || node.type !== 'compaction') continue
    const parsed = compactionSchema.safeParse(node)
    if (!parsed.success) continue
    const cutIndex = path.findIndex(
      (n) => n.id === parsed.data.firstKeptEntryId,
    )
    if (cutIndex === -1) continue
    return {
      cutIndex,
      summary: parsed.data.summary,
      tokensBefore: parsed.data.tokensBefore ?? null,
      timestamp: parsed.data.timestamp,
    }
  }
  return null
}

function collectLabels(path: readonly Node[]): Map<string, string[]> {
  const onPath = new Set(path.map((n) => n.id))
  const out = new Map<string, string[]>()
  for (const node of path) {
    if (node.type !== 'label') continue
    const parsed = labelSchema.safeParse(node)
    if (!parsed.success) continue
    if (!onPath.has(parsed.data.targetId)) continue
    const list = out.get(parsed.data.targetId)
    if (list === undefined) out.set(parsed.data.targetId, [parsed.data.label])
    else list.push(parsed.data.label)
  }
  return out
}

function compactionSummaryMessage(cut: CompactionCut): NormalizedMessage {
  const attr =
    cut.tokensBefore === null ? '' : ` tokensBefore="${cut.tokensBefore}"`
  const text = `<compaction${attr}>\n${cut.summary}\n</compaction>`
  const ts = Date.parse(cut.timestamp)
  return {
    role: 'user',
    timestampMs: Number.isNaN(ts) ? null : ts,
    parts: [{ kind: 'text', text }],
  }
}

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
  const fullPath = activePath(tree)
  const frontmatterYaml = frontmatterToYaml(buildFrontmatter(tree))

  const messages: NormalizedMessage[] = []
  const pending = new Map<string, PendingToolCall>()

  const cut = findCompactionCut(fullPath)
  const path = cut === null ? fullPath : fullPath.slice(cut.cutIndex)
  if (cut !== null) messages.push(compactionSummaryMessage(cut))

  const labelsByTargetId = collectLabels(path)

  const appendLabels = (targetId: string, parts: Part[]): void => {
    const labels = labelsByTargetId.get(targetId)
    if (labels === undefined) return
    for (const label of labels) {
      parts.push({ kind: 'text', text: `[label: ${label}]` })
    }
  }

  const emitStatus = (
    timestampMs: number | null,
    text: string,
    nodeId: string,
  ): void => {
    const parts: Part[] = [{ kind: 'text', text }]
    appendLabels(nodeId, parts)
    messages.push({ role: 'user', timestampMs, parts })
  }

  for (const node of path) {
    if (node.type === 'custom') continue
    if (node.type === 'session_info') continue
    if (node.type === 'label') continue
    if (node.type === 'compaction') continue

    const ts = Date.parse(node.timestamp)
    const timestampMs = Number.isNaN(ts) ? null : ts

    const model = modelChangeSchema.safeParse(node)
    if (model.success) {
      emitStatus(
        timestampMs,
        `> model: ${model.data.provider}/${model.data.modelId}`,
        node.id,
      )
      continue
    }

    const thinking = thinkingLevelChangeSchema.safeParse(node)
    if (thinking.success) {
      emitStatus(
        timestampMs,
        `> thinking_level: ${thinking.data.thinkingLevel}`,
        node.id,
      )
      continue
    }

    const bs = branchSummarySchema.safeParse(node)
    if (bs.success) {
      emitStatus(
        timestampMs,
        `<branch_summary>\n${bs.data.summary}\n</branch_summary>`,
        node.id,
      )
      continue
    }

    const cm = customMessageSchema.safeParse(node)
    if (cm.success) {
      const parts: Part[] = [
        {
          kind: 'tool',
          id: node.id,
          name: cm.data.customType,
          input: collectCustomMessageInput(node),
        },
      ]
      appendLabels(node.id, parts)
      messages.push({ role: 'user', timestampMs, parts })
      continue
    }

    const bash = bashExecPayloadSchema.safeParse(node)
    if (bash.success) {
      const parts: Part[] = [
        {
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
        },
      ]
      appendLabels(node.id, parts)
      messages.push({ role: 'user', timestampMs, parts })
      continue
    }

    const tr = toolResultPayloadSchema.safeParse(node)
    if (tr.success) {
      const target = pending.get(tr.data.message.toolCallId)
      if (target === undefined) continue
      const content = joinText(tr.data.message.content ?? [])
      const result: ToolResult = { content, isError: false }
      if (tr.data.message.details !== undefined) {
        result.details = tr.data.message.details
      }
      target.part.result = result
      continue
    }

    const msg = userOrAssistantSchema.safeParse(node)
    if (!msg.success) continue
    const role = mapRole(msg.data.message.role)
    if (role === null) continue
    const parts = buildParts(msg.data.message.content ?? [], pending)
    appendLabels(node.id, parts)
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

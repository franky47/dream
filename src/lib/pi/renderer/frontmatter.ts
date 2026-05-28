import { z } from 'zod'

import { activePath, type Node, parseTree, type PiTree } from './entries.ts'

const RENDERER_VERSION = 'pi-md@1'

export interface Frontmatter {
  sessionId: string
  cwd: string
  version: number
  startedAt: string
  parentSession: string | null
  sessionName: string
  latestProvider: string
  latestModelId: string
  thinkingLevel: string
  totalTokens: number
  cost: number
  turns: number
  toolUses: number
  renderer: string
}

const usageSchema = z.object({
  totalTokens: z.number().optional(),
  cost: z.object({ total: z.number().optional() }).optional(),
})

const messageBodySchema = z.object({
  role: z.string(),
  content: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  usage: usageSchema.optional(),
})

const messagePayloadSchema = z.object({
  type: z.literal('message'),
  message: messageBodySchema,
})

const modelChangeSchema = z.object({
  type: z.literal('model_change'),
  provider: z.string(),
  modelId: z.string(),
})

const thinkingChangeSchema = z.object({
  type: z.literal('thinking_level_change'),
  thinkingLevel: z.string(),
})

const sessionInfoSchema = z.object({
  type: z.literal('session_info'),
  name: z.string(),
})

export function extractFrontmatter(jsonlText: string): Frontmatter {
  return buildFrontmatter(parseTree(jsonlText))
}

export function buildFrontmatter(tree: PiTree): Frontmatter {
  const path: readonly Node[] = activePath(tree)
  const header = tree.header

  let turns = 0
  let toolUses = 0
  let totalTokens = 0
  let cost = 0
  let latestProvider = ''
  let latestModelId = ''
  let thinkingLevel = ''
  let sessionName = ''

  for (const node of path) {
    const model = modelChangeSchema.safeParse(node)
    if (model.success) {
      latestProvider = model.data.provider
      latestModelId = model.data.modelId
      continue
    }
    const thinking = thinkingChangeSchema.safeParse(node)
    if (thinking.success) {
      thinkingLevel = thinking.data.thinkingLevel
      continue
    }
    const info = sessionInfoSchema.safeParse(node)
    if (info.success) {
      sessionName = info.data.name
      continue
    }
    const msg = messagePayloadSchema.safeParse(node)
    if (!msg.success) continue
    if (msg.data.message.role === 'user') turns += 1
    for (const part of msg.data.message.content ?? []) {
      if (part.type === 'toolCall') toolUses += 1
    }
    const usage = msg.data.message.usage
    if (usage !== undefined) {
      totalTokens += usage.totalTokens ?? 0
      cost += usage.cost?.total ?? 0
    }
  }

  return {
    sessionId: header?.id ?? '',
    cwd: header?.cwd ?? '',
    version: header?.version ?? 0,
    startedAt: header?.timestamp ?? '',
    parentSession: header?.parentSession ?? null,
    sessionName,
    latestProvider,
    latestModelId,
    thinkingLevel,
    totalTokens,
    cost,
    turns,
    toolUses,
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
  lines.push(`version: ${fm.version}`)
  lines.push(`startedAt: ${fm.startedAt}`)
  lines.push(
    `parentSession: ${
      fm.parentSession === null ? 'null' : yamlEscapeString(fm.parentSession)
    }`,
  )
  lines.push(`sessionName: ${yamlEscapeString(fm.sessionName)}`)
  lines.push(`latestProvider: ${yamlEscapeString(fm.latestProvider)}`)
  lines.push(`latestModelId: ${yamlEscapeString(fm.latestModelId)}`)
  lines.push(`thinkingLevel: ${yamlEscapeString(fm.thinkingLevel)}`)
  lines.push(`totalTokens: ${fm.totalTokens}`)
  lines.push(`cost: ${fm.cost}`)
  lines.push(`turns: ${fm.turns}`)
  lines.push(`toolUses: ${fm.toolUses}`)
  lines.push(`renderer: ${yamlEscapeString(fm.renderer)}`)
  lines.push('---')
  return lines.join('\n') + '\n'
}

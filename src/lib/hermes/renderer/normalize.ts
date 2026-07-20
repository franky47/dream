import { z } from 'zod'

import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  Role,
} from '#lib/renderer/types'

import { stripDiscordTriggerNote } from './discord.ts'
import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'

const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number(),
})

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

export function normalize(jsonlText: string): NormalizedSession {
  const raws = parseLines(jsonlText)
  const frontmatterYaml = frontmatterToYaml(extractFrontmatter(jsonlText))

  const messages: NormalizedMessage[] = []
  for (const raw of raws) {
    const msg = messageRowSchema.safeParse(raw)
    if (!msg.success) continue
    const text =
      msg.data.role === 'user'
        ? stripDiscordTriggerNote(msg.data.content)
        : msg.data.content
    const parts: Part[] = text.length > 0 ? [{ kind: 'text', text }] : []
    messages.push({
      role: msg.data.role satisfies Role,
      timestampMs: msg.data.createdAt,
      parts,
    })
  }

  return { frontmatterYaml, messages }
}

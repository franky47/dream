import { z } from 'zod'

import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  Role,
} from '#lib/renderer/types'

import { extractFrontmatter, frontmatterToYaml } from './frontmatter.ts'
import { isRewound } from './rewound.ts'

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
    if (isRewound(raw)) continue
    const msg = messageRowSchema.safeParse(raw)
    if (!msg.success) continue
    const parts: Part[] =
      msg.data.content.length > 0
        ? [{ kind: 'text', text: msg.data.content }]
        : []
    messages.push({
      role: msg.data.role satisfies Role,
      timestampMs: msg.data.createdAt,
      parts,
    })
  }

  return { frontmatterYaml, messages }
}

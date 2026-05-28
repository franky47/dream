import { z } from 'zod'

const RENDERER_VERSION = 'codex-md@1'

const gitSchema = z.object({
  commit_hash: z.string(),
  branch: z.string(),
  repository_url: z.string(),
})

const sessionMetaSchema = z.object({
  type: z.literal('session_meta'),
  payload: z.object({
    id: z.string(),
    timestamp: z.string(),
    cwd: z.string(),
    originator: z.string(),
    cli_version: z.string(),
    model_provider: z.string(),
    git: gitSchema.nullable().optional(),
  }),
})

const wrapperSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  payload: z.unknown(),
})

const responseItemSchema = z.object({
  type: z.literal('response_item'),
  payload: z.object({ type: z.string() }).passthrough(),
})

const messagePayloadSchema = z.object({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'developer']),
})

interface FrontmatterGit {
  commitHash: string
  branch: string
  repositoryUrl: string
}

export interface Frontmatter {
  sessionId: string
  cwd: string
  startedAt: string
  endedAt: string
  turns: number
  toolUses: number
  originator: string
  cliVersion: string
  modelProvider: string
  git: FrontmatterGit | null
  renderer: string
}

function parseRows(jsonlText: string): unknown[] {
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

export function extractFrontmatter(jsonlText: string): Frontmatter {
  const raws = parseRows(jsonlText)

  let meta: z.infer<typeof sessionMetaSchema>['payload'] | null = null
  let userTurns = 0
  let toolUses = 0
  let lastTimestamp = ''

  for (const raw of raws) {
    const wrap = wrapperSchema.safeParse(raw)
    if (!wrap.success) continue
    lastTimestamp = wrap.data.timestamp

    const m = sessionMetaSchema.safeParse(raw)
    if (m.success) {
      meta ??= m.data.payload
      continue
    }

    const ri = responseItemSchema.safeParse(raw)
    if (!ri.success) continue
    const ptype = ri.data.payload.type

    if (ptype === 'function_call' || ptype === 'custom_tool_call') {
      toolUses += 1
      continue
    }
    if (ptype === 'message') {
      const mp = messagePayloadSchema.safeParse(ri.data.payload)
      if (mp.success && mp.data.role === 'user') userTurns += 1
    }
  }

  const git =
    meta?.git == null
      ? null
      : {
          commitHash: meta.git.commit_hash,
          branch: meta.git.branch,
          repositoryUrl: meta.git.repository_url,
        }

  return {
    sessionId: meta?.id ?? '',
    cwd: meta?.cwd ?? '',
    startedAt: meta?.timestamp ?? '',
    endedAt: lastTimestamp || (meta?.timestamp ?? ''),
    turns: userTurns,
    toolUses,
    originator: meta?.originator ?? '',
    cliVersion: meta?.cli_version ?? '',
    modelProvider: meta?.model_provider ?? '',
    git,
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
  lines.push(`startedAt: ${fm.startedAt}`)
  lines.push(`endedAt: ${fm.endedAt}`)
  lines.push(`turns: ${fm.turns}`)
  lines.push(`toolUses: ${fm.toolUses}`)
  lines.push(`originator: ${yamlEscapeString(fm.originator)}`)
  lines.push(`cliVersion: ${yamlEscapeString(fm.cliVersion)}`)
  lines.push(`modelProvider: ${yamlEscapeString(fm.modelProvider)}`)
  if (fm.git === null) {
    lines.push('git: null')
  } else {
    lines.push('git:')
    lines.push(`  commit_hash: ${yamlEscapeString(fm.git.commitHash)}`)
    lines.push(`  branch: ${yamlEscapeString(fm.git.branch)}`)
    lines.push(`  repository_url: ${yamlEscapeString(fm.git.repositoryUrl)}`)
  }
  lines.push(`renderer: ${yamlEscapeString(fm.renderer)}`)
  lines.push('---')
  return lines.join('\n') + '\n'
}

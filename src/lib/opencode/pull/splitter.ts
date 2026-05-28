import { mkdir, open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { utcDay } from '#lib/utc-day'

export type SplitterMetrics = {
  sessions_pulled: number
  messages_pulled: number
  parts_pulled: number
  bytes: number
  sessionPaths: string[]
}

const rowEnvelopeSchema = z.object({
  type: z.string(),
  sessionId: z.string(),
})

// The first row of every session is its header (the projection orders
// session rows ahead of their messages/parts). It carries `time_updated`,
// which routes the whole session file to its UTC-day bucket.
const sessionHeaderSchema = z.object({
  type: z.literal('session'),
  sessionId: z.string(),
  time_updated: z.number(),
})

export async function splitJsonlToSessionFiles(opts: {
  lines: AsyncIterable<string>
  dataDir: string
  machine: string
}): Promise<SplitterMetrics> {
  const metrics: SplitterMetrics = {
    sessions_pulled: 0,
    messages_pulled: 0,
    parts_pulled: 0,
    bytes: 0,
    sessionPaths: [],
  }
  let currentSessionId: string | null = null
  let handle: FileHandle | null = null

  for await (const line of opts.lines) {
    if (line.length === 0) continue
    const parsed: unknown = JSON.parse(line)
    const env = rowEnvelopeSchema.parse(parsed)
    if (env.sessionId !== currentSessionId) {
      if (handle !== null) await handle.close()
      const header = sessionHeaderSchema.parse(parsed)
      const dir = path.join(
        opts.dataDir,
        utcDay(new Date(header.time_updated)),
        opts.machine,
        'opencode',
      )
      await mkdir(dir, { recursive: true })
      const sessionPath = path.join(dir, `${env.sessionId}.jsonl`)
      handle = await open(sessionPath, 'w')
      metrics.sessionPaths.push(sessionPath)
      currentSessionId = env.sessionId
    }
    if (handle === null) throw new Error('unreachable: handle is null')
    const payload = `${line}\n`
    await handle.write(payload)
    metrics.bytes += Buffer.byteLength(payload)
    if (env.type === 'session') metrics.sessions_pulled += 1
    else if (env.type === 'message') metrics.messages_pulled += 1
    else if (env.type === 'part') metrics.parts_pulled += 1
  }
  if (handle !== null) await handle.close()
  return metrics
}

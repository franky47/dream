import { open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

export type SplitterMetrics = {
  sessions_pulled: number
  messages_pulled: number
  parts_pulled: number
  bytes: number
}

const rowEnvelopeSchema = z.object({
  type: z.string(),
  sessionId: z.string(),
})

export async function splitJsonlToSessionFiles(opts: {
  lines: AsyncIterable<string>
  outDir: string
}): Promise<SplitterMetrics> {
  const metrics: SplitterMetrics = {
    sessions_pulled: 0,
    messages_pulled: 0,
    parts_pulled: 0,
    bytes: 0,
  }
  let currentSessionId: string | null = null
  let handle: FileHandle | null = null

  for await (const line of opts.lines) {
    if (line.length === 0) continue
    const env = rowEnvelopeSchema.parse(JSON.parse(line))
    if (env.sessionId !== currentSessionId) {
      if (handle !== null) await handle.close()
      const filePath = path.join(opts.outDir, `${env.sessionId}.jsonl`)
      handle = await open(filePath, 'w')
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

import { mkdir, open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { utcDay } from '#lib/utc-day'

export type SplitterMetrics = {
  sessions_pulled: number
  messages_pulled: number
  bytes: number
  sessionPaths: string[]
}

// A rotated chain projects several physical `session` rows under one
// `logicalId` (the root UUID). Grouping by that id keeps every rotation in one
// file; a session with no continuations carries no `logicalId`, so it falls
// back to its own id and lands in its own file exactly as before.
const rowEnvelopeSchema = z.object({
  type: z.enum(['session', 'message']),
  sessionId: z.string(),
  logicalId: z.string().optional(),
})

// The projection orders each logical session's root header row ahead of its
// members. That header carries the logical `latestMessageTime`, which routes
// the whole snapshot to the UTC-day bucket of the joined conversation's most
// recent message.
const sessionHeaderSchema = z.object({
  type: z.literal('session'),
  sessionId: z.string(),
  logicalId: z.string().optional(),
  latestMessageTime: z.number(),
})

function logicalKey(env: { sessionId: string; logicalId?: string }): string {
  return env.logicalId ?? env.sessionId
}

class HermesRowInvalid extends Error {
  override name = 'HermesRowInvalid'
}

function parseLine<T>(schema: z.ZodType<T>, line: string, context: string): T {
  const parsed: unknown = JSON.parse(line)
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new HermesRowInvalid(`${context}: ${z.prettifyError(result.error)}`)
  }
  return result.data
}

export async function splitJsonlToSessionFiles(opts: {
  lines: AsyncIterable<string>
  dataDir: string
  machine: string
}): Promise<SplitterMetrics> {
  const metrics: SplitterMetrics = {
    sessions_pulled: 0,
    messages_pulled: 0,
    bytes: 0,
    sessionPaths: [],
  }
  let currentKey: string | null = null
  let handle: FileHandle | null = null

  try {
    for await (const line of opts.lines) {
      if (line.length === 0) continue
      const env = parseLine(
        rowEnvelopeSchema,
        line,
        `hermes/${opts.machine}: malformed row`,
      )
      const key = logicalKey(env)
      if (key !== currentKey) {
        if (handle !== null) await handle.close()
        const header = parseLine(
          sessionHeaderSchema,
          line,
          `hermes/${opts.machine}: session ${key} header`,
        )
        const dir = path.join(
          opts.dataDir,
          utcDay(new Date(header.latestMessageTime)),
          opts.machine,
          'hermes',
        )
        await mkdir(dir, { recursive: true })
        const sessionPath = path.join(dir, `${key}.jsonl`)
        handle = await open(sessionPath, 'w')
        metrics.sessionPaths.push(sessionPath)
        metrics.sessions_pulled += 1
        currentKey = key
      }
      if (handle === null) {
        throw new HermesRowInvalid(
          `hermes/${opts.machine}: message ${env.sessionId} precedes its session header`,
        )
      }
      const payload = `${line}\n`
      await handle.write(payload)
      metrics.bytes += Buffer.byteLength(payload)
      if (env.type === 'message') metrics.messages_pulled += 1
    }
  } finally {
    if (handle !== null) await handle.close()
  }
  return metrics
}

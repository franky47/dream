import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import * as errore from 'errore'
import { z } from 'zod'

import { utcDay } from '#lib/utc-day'

export type SplitterMetrics = {
  sessions_pulled: number
  messages_pulled: number
  bytes: number
  sessionPaths: string[]
}

// The stream is validated in full before a single final file appears. Staging
// keeps each session's lines in memory and `commit` writes them only once the
// caller is satisfied the whole stream arrived intact (locally: the loop ran to
// completion; over SSH: the transport also exited 0). A malformed late row or a
// dropped transport therefore never leaves a truncated `.jsonl` on disk.
export type StagedSplit = SplitterMetrics & {
  commit: () => Promise<void>
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

// Every message row needs a `role` and a `createdAt` to route and render;
// validating them here, at the ingest gate, turns a would-be silent omission
// into a loud failure and keeps `messages_pulled` honest. `content` is nullable
// in the state db: an assistant row carrying only `tool_calls` legitimately
// stores no text. So the gate accepts `content: null` while still rejecting a
// row with no role or no timestamp as truly malformed.
const messageRowSchema = z.object({
  type: z.literal('message'),
  role: z.string(),
  content: z.string().nullable(),
  createdAt: z.number(),
})

// A session id becomes a filename, so it must be a single safe path segment.
// Anything with a separator, a `..` traversal, a leading dash (would read as a
// flag) or an out-of-charset character is rejected before it can escape the day
// bucket. Real Hermes ids are `ses_…` slugs or UUIDs, well inside this set.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function logicalKey(env: { sessionId: string; logicalId?: string }): string {
  return env.logicalId ?? env.sessionId
}

// A tagged error carrying the source machine and a human-readable detail, so a
// malformed row fails loudly with machine and context, matching `SshSourceFailure`.
class HermesRowInvalid extends errore.createTaggedError({
  name: 'HermesRowInvalid',
  message: 'hermes/$machine: $detail',
}) {}

function assertSafeSegment(key: string, machine: string): void {
  if (key.length === 0 || key.includes('..') || !SAFE_SEGMENT.test(key)) {
    throw new HermesRowInvalid({
      machine,
      detail: `unsafe session id ${JSON.stringify(key)}`,
    })
  }
}

function parseLine<T>(opts: {
  schema: z.ZodType<T>
  line: string
  machine: string
  context: string
}): T {
  const parsed = errore.try({
    try: (): unknown => JSON.parse(opts.line),
    catch: (e) =>
      new HermesRowInvalid({
        machine: opts.machine,
        detail: `${opts.context}: not valid JSON`,
        cause: e,
      }),
  })
  if (parsed instanceof Error) throw parsed
  const result = opts.schema.safeParse(parsed)
  if (!result.success) {
    throw new HermesRowInvalid({
      machine: opts.machine,
      detail: `${opts.context}: ${z.prettifyError(result.error)}`,
    })
  }
  return result.data
}

type StagedSession = {
  dir: string
  path: string
  chunks: string[]
}

export async function splitJsonlToSessionFiles(opts: {
  lines: AsyncIterable<string>
  dataDir: string
  machine: string
}): Promise<StagedSplit> {
  const metrics: SplitterMetrics = {
    sessions_pulled: 0,
    messages_pulled: 0,
    bytes: 0,
    sessionPaths: [],
  }
  const staged: StagedSession[] = []
  const seenKeys = new Set<string>()
  let currentKey: string | null = null
  let current: StagedSession | null = null

  for await (const line of opts.lines) {
    if (line.length === 0) continue
    const env = parseLine({
      schema: rowEnvelopeSchema,
      line,
      machine: opts.machine,
      context: 'malformed row',
    })
    const key = logicalKey(env)
    if (key !== currentKey) {
      // The projection groups every row of a logical session contiguously, so a
      // key that reappears after another key means the stream is interleaved.
      // Staging a second session under the same path would clobber the first at
      // commit, so reject the stream instead.
      if (seenKeys.has(key)) {
        throw new HermesRowInvalid({
          machine: opts.machine,
          detail: `session ${key} reappears after another session`,
        })
      }
      assertSafeSegment(key, opts.machine)
      const header = parseLine({
        schema: sessionHeaderSchema,
        line,
        machine: opts.machine,
        context: `session ${key} header`,
      })
      const dir = path.join(
        opts.dataDir,
        utcDay(new Date(header.latestMessageTime)),
        opts.machine,
        'hermes',
      )
      const sessionPath = path.join(dir, `${key}.jsonl`)
      current = { dir, path: sessionPath, chunks: [] }
      staged.push(current)
      metrics.sessionPaths.push(sessionPath)
      metrics.sessions_pulled += 1
      seenKeys.add(key)
      currentKey = key
    }
    if (current === null) {
      throw new HermesRowInvalid({
        machine: opts.machine,
        detail: `message ${env.sessionId} precedes its session header`,
      })
    }
    if (env.type === 'message') {
      parseLine({
        schema: messageRowSchema,
        line,
        machine: opts.machine,
        context: `message ${env.sessionId}`,
      })
    }
    const payload = `${line}\n`
    current.chunks.push(payload)
    metrics.bytes += Buffer.byteLength(payload)
    if (env.type === 'message') metrics.messages_pulled += 1
  }

  const commit = async (): Promise<void> => {
    for (const session of staged) {
      await mkdir(session.dir, { recursive: true })
      await Bun.write(session.path, session.chunks.join(''))
    }
  }

  return { ...metrics, commit }
}

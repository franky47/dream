import { z } from 'zod'

import type { SourceResult } from '#src/ingest/orchestrator'

const okEntrySchema = z
  .object({
    machine: z.string().min(1),
    source: z.string().min(1),
    status: z.literal('ok'),
    duration_ms: z.int().nonnegative(),
  })
  .catchall(z.union([z.number(), z.string()]))

const errorEntrySchema = z.object({
  machine: z.string().min(1),
  source: z.string().min(1),
  status: z.literal('error'),
  duration_ms: z.int().nonnegative(),
  error: z.object({
    name: z.string().min(1),
    message: z.string(),
    tag: z.string().nullable(),
  }),
})

const runLogSchema = z.object({
  run_started_at: z.iso.datetime(),
  run_finished_at: z.iso.datetime(),
  sources: z.array(z.union([okEntrySchema, errorEntrySchema])),
})

export type RunLog = z.infer<typeof runLogSchema>

export function buildRunLog(opts: {
  runStartedAt: Date
  runFinishedAt: Date
  results: ReadonlyArray<SourceResult>
}): RunLog {
  const sources = opts.results.map((r) =>
    r.status === 'ok'
      ? {
          ...r.metrics,
          machine: r.machine,
          source: r.source,
          status: 'ok' as const,
          duration_ms: r.durationMs,
        }
      : {
          machine: r.machine,
          source: r.source,
          status: 'error' as const,
          duration_ms: r.durationMs,
          error: r.error,
        },
  )
  return runLogSchema.parse({
    run_started_at: opts.runStartedAt.toISOString(),
    run_finished_at: opts.runFinishedAt.toISOString(),
    sources,
  })
}

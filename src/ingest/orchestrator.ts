import { rm } from 'node:fs/promises'
import path from 'node:path'

import * as errore from 'errore'

import { daysInRange } from '#src/ingest/utc-day'

type Metrics = Record<string, number | string>

export type Source = {
  machine: string
  source: string
  pull(opts: { dataDir: string; since: Date; until: Date }): Promise<Metrics>
}

export type SourceResult =
  | {
      machine: string
      source: string
      status: 'ok'
      durationMs: number
      metrics: Metrics
    }
  | {
      machine: string
      source: string
      status: 'error'
      durationMs: number
      error: { name: string; message: string; tag: string | null }
    }

class SourceFailure extends errore.createTaggedError({
  name: 'SourceFailure',
  message: 'Source $machine/$source failed: $reason',
}) {}

export class IngestFatal extends errore.createTaggedError({
  name: 'IngestFatal',
  message: 'Ingest cannot continue: $reason',
}) {}

export type RunOutcome = {
  runStartedAt: Date
  runFinishedAt: Date
  results: SourceResult[]
}

function describeError(e: SourceFailure): {
  name: string
  message: string
  tag: string
} {
  return { name: e.name, message: e.message, tag: e._tag }
}

async function runOne({
  source,
  dataDir,
  since,
  until,
}: {
  source: Source
  dataDir: string
  since: Date
  until: Date
}): Promise<SourceResult> {
  const start = performance.now()
  const metrics = await source.pull({ dataDir, since, until }).catch(
    (e) =>
      new SourceFailure({
        machine: source.machine,
        source: source.source,
        reason: e instanceof Error ? e.message : String(e),
        cause: e,
      }),
  )
  const durationMs = Math.round(performance.now() - start)
  if (metrics instanceof Error) {
    return {
      machine: source.machine,
      source: source.source,
      status: 'error',
      durationMs,
      error: describeError(metrics),
    }
  }
  return {
    machine: source.machine,
    source: source.source,
    status: 'ok',
    durationMs,
    metrics,
  }
}

async function clearDayBucket(dayDir: string): Promise<IngestFatal | void> {
  const removed = await rm(dayDir, { recursive: true, force: true }).catch(
    (e) =>
      new IngestFatal({
        reason: `failed to clear day-bucket ${dayDir}`,
        cause: e,
      }),
  )
  if (removed instanceof Error) return removed
}

export async function run(opts: {
  sources: ReadonlyArray<Source>
  dataDir: string
  since: Date
  until: Date
  clearDay?: (dayDir: string) => Promise<IngestFatal | void>
}): Promise<IngestFatal | RunOutcome> {
  const runStartedAt = new Date()
  const clear = opts.clearDay ?? clearDayBucket

  const cleared = await Promise.all(
    daysInRange(opts.since, opts.until).map((day) =>
      clear(path.join(opts.dataDir, day)),
    ),
  )
  const clearFailure = cleared.find((c) => c instanceof Error)
  if (clearFailure) return clearFailure

  const results = await Promise.all(
    opts.sources.map((source) =>
      runOne({
        source,
        dataDir: opts.dataDir,
        since: opts.since,
        until: opts.until,
      }),
    ),
  )
  const runFinishedAt = new Date()
  return { runStartedAt, runFinishedAt, results }
}

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import * as errore from 'errore'

type Metrics = Record<string, number | string>

export type Source = {
  machine: string
  source: string
  pull(opts: { outDir: string; since: Date }): Promise<Metrics>
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

export type RunOutcome = {
  runStartedAt: Date
  runFinishedAt: Date
  results: SourceResult[]
}

function describeError(e: unknown): {
  name: string
  message: string
  tag: string | null
} {
  if (errore.isTaggedError(e)) {
    return { name: e.name, message: e.message, tag: e._tag }
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message, tag: null }
  }
  return { name: 'NonError', message: String(e), tag: null }
}

async function runOne({
  source,
  dataDir,
  since,
}: {
  source: Source
  dataDir: string
  since: Date
}): Promise<SourceResult> {
  const outDir = path.join(dataDir, 'raw', source.machine, source.source)
  const start = performance.now()
  const prep = await rm(outDir, { recursive: true, force: true })
    .then(() => mkdir(outDir, { recursive: true }))
    .catch(
      (e) =>
        new SourceFailure({
          machine: source.machine,
          source: source.source,
          reason: 'failed to prepare outDir',
          cause: e,
        }),
    )
  if (prep instanceof Error) {
    return {
      machine: source.machine,
      source: source.source,
      status: 'error',
      durationMs: Math.round(performance.now() - start),
      error: describeError(prep),
    }
  }

  const metrics = await source.pull({ outDir, since }).catch(
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

export async function run(opts: {
  sources: ReadonlyArray<Source>
  dataDir: string
  since: Date
}): Promise<RunOutcome> {
  const runStartedAt = new Date()
  const settled = await Promise.all(
    opts.sources.map((source) =>
      runOne({ source, dataDir: opts.dataDir, since: opts.since }),
    ),
  )
  const runFinishedAt = new Date()
  return { runStartedAt, runFinishedAt, results: settled }
}

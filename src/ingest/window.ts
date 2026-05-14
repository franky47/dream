import { parseArgs } from 'node:util'

import * as errore from 'errore'
import { z } from 'zod'

const INGEST_WINDOW_HOURS = 48

export class WindowError extends errore.createTaggedError({
  name: 'WindowError',
  message: 'Invalid ingest window: $reason',
}) {}

const isoDate = z.iso.date()
const isoDateTime = z.iso.datetime({ offset: true })

function parseWindowValue(raw: string): Date | null {
  if (isoDate.safeParse(raw).success) return new Date(`${raw}T00:00:00.000Z`)
  if (isoDateTime.safeParse(raw).success) return new Date(raw)
  return null
}

export function resolveWindow(argv: string[], now: Date) {
  const parsed = errore.try({
    try: () =>
      parseArgs({
        args: argv,
        options: {
          since: { type: 'string' },
          until: { type: 'string' },
        },
        strict: true,
        allowPositionals: true,
      }),
    catch: (e) =>
      new WindowError({ reason: 'could not parse arguments', cause: e }),
  })
  if (parsed instanceof Error) return parsed

  const sinceRaw = parsed.values.since
  const untilRaw = parsed.values.until

  if (untilRaw !== undefined && sinceRaw === undefined) {
    return new WindowError({ reason: '--until requires --since' })
  }

  const until = untilRaw === undefined ? now : parseWindowValue(untilRaw)
  if (until === null) {
    return new WindowError({ reason: `unparseable --until value: ${untilRaw}` })
  }

  const since =
    sinceRaw === undefined
      ? new Date(until.getTime() - INGEST_WINDOW_HOURS * 60 * 60 * 1000)
      : parseWindowValue(sinceRaw)
  if (since === null) {
    return new WindowError({ reason: `unparseable --since value: ${sinceRaw}` })
  }

  if (since.getTime() >= until.getTime()) {
    return new WindowError({
      reason: `since (${since.toISOString()}) must be before until (${until.toISOString()})`,
    })
  }

  return { since, until, untilWasExplicit: untilRaw !== undefined }
}

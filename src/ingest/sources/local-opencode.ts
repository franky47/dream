import { Database } from 'bun:sqlite'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { projectRows, splitJsonlToSessionFiles } from '#lib/opencode/pull'
import type { Source } from '#src/ingest/orchestrator'
import { utcDay } from '#src/ingest/utc-day'

const DEFAULT_DB_PATH = path.join(
  homedir(),
  '.local',
  'share',
  'opencode',
  'opencode.db',
)

async function* arrayToAsyncIterable<T>(
  arr: ReadonlyArray<T>,
): AsyncIterable<T> {
  for (const item of arr) yield item
}

export function ingestLocalOpencode(opts: {
  machine: string
  dbPath?: string
}): Source {
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH
  return {
    machine: opts.machine,
    source: 'opencode',
    pull: async ({ dataDir, since, until }) => {
      const db = new Database(dbPath, { readonly: true })
      try {
        const rows = projectRows({ db, sinceMs: since.getTime() })
        // Per-session day routing and the strict `until` upper bound (a SQL
        // `time_updated < until` clause) are deferred to dream-7ear; for now
        // the whole pull lands in the day-bucket of the window's last instant.
        const outDir = path.join(
          dataDir,
          utcDay(new Date(until.getTime() - 1)),
          opts.machine,
          'opencode',
        )
        await mkdir(outDir, { recursive: true })
        return await splitJsonlToSessionFiles({
          lines: arrayToAsyncIterable(rows),
          outDir,
        })
      } finally {
        db.close()
      }
    },
  }
}

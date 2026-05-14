import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'

import { projectRows, splitJsonlToSessionFiles } from '#lib/opencode/pull'
import type { Source } from '#src/ingest/orchestrator'

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
        const rows = projectRows({
          db,
          sinceMs: since.getTime(),
          untilMs: until.getTime(),
        })
        return await splitJsonlToSessionFiles({
          lines: arrayToAsyncIterable(rows),
          dataDir,
          machine: opts.machine,
        })
      } finally {
        db.close()
      }
    },
  }
}

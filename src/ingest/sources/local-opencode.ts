import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'

import { projectRows, splitJsonlToSessionFiles } from '#lib/opencode/pull'
import { renderOpencodeSession } from '#lib/opencode/renderer'
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
        const { sessionPaths, ...metrics } = await splitJsonlToSessionFiles({
          lines: arrayToAsyncIterable(rows),
          dataDir,
          machine: opts.machine,
        })
        for (const jsonlPath of sessionPaths) {
          const jsonlText = await Bun.file(jsonlPath).text()
          const md = renderOpencodeSession(jsonlText)
          await Bun.write(jsonlPath.replace(/\.jsonl$/, '.md'), md)
        }
        return metrics
      } finally {
        db.close()
      }
    },
  }
}

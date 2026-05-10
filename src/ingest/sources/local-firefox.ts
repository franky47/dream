import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as errore from 'errore'
import { z } from 'zod'

import type { Source } from '#src/ingest/orchestrator'

class LocalFirefoxFailure extends errore.createTaggedError({
  name: 'LocalFirefoxFailure',
  message: 'local-firefox $stage failed: $reason',
}) {}

const placeRowSchema = z.object({
  visited: z.string(),
  url: z.string(),
  title: z.string(),
})
const placeRowsSchema = z.array(placeRowSchema)

function localDateStamp(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function snapshotPlaces(profileDir: string): string {
  let tmp: string
  try {
    tmp = mkdtempSync(path.join(tmpdir(), 'dream-firefox-snap-'))
  } catch (cause) {
    throw new LocalFirefoxFailure({
      stage: 'mkdtemp',
      reason: 'tmp dir',
      cause,
    })
  }
  const target = path.join(tmp, 'places.sqlite')
  try {
    const src = new Database(path.join(profileDir, 'places.sqlite'), {
      readonly: true,
    })
    try {
      const escaped = target.replace(/'/g, "''")
      src.run(`VACUUM INTO '${escaped}'`)
    } finally {
      src.close()
    }
  } catch (cause) {
    rmSync(tmp, { recursive: true, force: true })
    throw new LocalFirefoxFailure({
      stage: 'snapshot',
      reason: 'VACUUM INTO',
      cause,
    })
  }
  return target
}

function readPlaces(snapshotPath: string, since: Date): unknown {
  try {
    const db = new Database(snapshotPath, { readonly: true })
    try {
      return db.query(QUERY).all({ $sinceMicros: since.getTime() * 1000 })
    } finally {
      db.close()
    }
  } catch (cause) {
    throw new LocalFirefoxFailure({
      stage: 'query',
      reason: 'reading places.sqlite',
      cause,
    })
  }
}

const QUERY = `
  WITH cleaned AS (
    SELECT
      last_visit_date,
      title,
      CASE
        WHEN INSTR(url, '?') > 0 THEN SUBSTR(url, 1, INSTR(url, '?') - 1)
        WHEN INSTR(url, '#') > 0 THEN SUBSTR(url, 1, INSTR(url, '#') - 1)
        ELSE url
      END AS url
    FROM moz_places
    WHERE last_visit_date > $sinceMicros
  )
  SELECT
    datetime(MAX(last_visit_date) / 1000000, 'unixepoch', 'localtime') AS visited,
    url,
    COALESCE(title, '') AS title
  FROM cleaned
  GROUP BY url
  ORDER BY visited DESC
`

export function ingestLocalFirefox(opts: {
  machine: string
  profileDir: string
}): Source {
  return {
    machine: opts.machine,
    source: 'firefox',
    pull: async ({ outDir, since }) => {
      const snapshotPath = snapshotPlaces(opts.profileDir)
      let raw: unknown
      try {
        raw = readPlaces(snapshotPath, since)
      } finally {
        rmSync(path.dirname(snapshotPath), { recursive: true, force: true })
      }
      const rows = placeRowsSchema.parse(raw)

      const lines = ['visited,url,title']
      for (const r of rows) {
        lines.push(
          `${csvField(r.visited)},${csvField(r.url)},${csvField(r.title)}`,
        )
      }
      const csv = lines.join('\n') + '\n'
      const outPath = path.join(outDir, `${localDateStamp(new Date())}.csv`)
      await Bun.write(outPath, csv)
      const bytes = statSync(outPath).size
      return { files_pulled: 1, bytes, rows: rows.length }
    },
  }
}

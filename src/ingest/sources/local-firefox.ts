import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
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
  visit_count: z.number().int().nonnegative(),
  frecency: z.number().int(),
  typed: z.number().int().nonnegative(),
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
  // Plain fs copy bypasses SQLite's advisory locks. Firefox keeps
  // places.sqlite under PRAGMA locking_mode=EXCLUSIVE while running, which
  // blocks any other SQLite connection (and therefore VACUUM INTO) from
  // opening the file. We mirror the original shell exporter: copy main first,
  // then -wal so committed-but-uncheckpointed entries are visible.
  const target = path.join(tmp, 'places.sqlite')
  try {
    copyFileSync(path.join(profileDir, 'places.sqlite'), target)
    const wal = path.join(profileDir, 'places.sqlite-wal')
    if (existsSync(wal)) {
      copyFileSync(wal, `${target}-wal`)
    }
  } catch (cause) {
    rmSync(tmp, { recursive: true, force: true })
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'snapshot',
      reason: `fs copy from ${profileDir}: ${detail}`,
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
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'query',
      reason: `reading places.sqlite: ${detail}`,
      cause,
    })
  }
}

const QUERY = `
  WITH cleaned AS (
    SELECT
      last_visit_date,
      title,
      visit_count,
      frecency,
      typed,
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
    COALESCE(title, '') AS title,
    COALESCE(SUM(visit_count), 0) AS visit_count,
    COALESCE(MAX(frecency), 0) AS frecency,
    COALESCE(MAX(typed), 0) AS typed
  FROM cleaned
  GROUP BY url
  ORDER BY visited DESC
`

function loadBlocklist(blocklistPath: string | undefined): string[] {
  if (!blocklistPath) return []
  let raw: string
  try {
    raw = readFileSync(blocklistPath, 'utf-8')
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'blocklist',
      reason: `read ${blocklistPath}: ${detail}`,
      cause,
    })
  }
  return raw
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
}

function isBlocked(url: string, blocklist: ReadonlyArray<string>): boolean {
  if (blocklist.length === 0) return false
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return blocklist.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

export function ingestLocalFirefox(opts: {
  machine: string
  profileDir: string
  blocklistPath?: string
}): Source {
  return {
    machine: opts.machine,
    source: 'firefox',
    pull: async ({ outDir, since }) => {
      const blocklist = loadBlocklist(opts.blocklistPath)
      const snapshotPath = snapshotPlaces(opts.profileDir)
      let raw: unknown
      try {
        raw = readPlaces(snapshotPath, since)
      } finally {
        rmSync(path.dirname(snapshotPath), { recursive: true, force: true })
      }
      const allRows = placeRowsSchema.parse(raw)
      const rows = allRows.filter((r) => !isBlocked(r.url, blocklist))
      const blocklistFiltered = allRows.length - rows.length

      const lines = ['visited,url,title,visit_count,frecency,typed']
      for (const r of rows) {
        lines.push(
          [
            csvField(r.visited),
            csvField(r.url),
            csvField(r.title),
            String(r.visit_count),
            String(r.frecency),
            String(r.typed),
          ].join(','),
        )
      }
      const csv = lines.join('\n') + '\n'
      const outPath = path.join(
        outDir,
        `${localDateStamp(new Date())}.history.csv`,
      )
      await Bun.write(outPath, csv)
      const bytes = statSync(outPath).size
      return {
        files_pulled: 1,
        bytes,
        rows: rows.length,
        blocklist_filtered: blocklistFiltered,
      }
    },
  }
}

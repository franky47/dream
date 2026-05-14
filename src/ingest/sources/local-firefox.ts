import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as errore from 'errore'
import * as lz4js from 'lz4js'
import { z } from 'zod'

import { utcDay } from '#lib/utc-day'
import type { Source } from '#src/ingest/orchestrator'

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000

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

const bookmarkRowSchema = z.object({
  bookmarked_at: z.string(),
  url: z.string(),
  title: z.string(),
  guid: z.string(),
})
const bookmarkRowsSchema = z.array(bookmarkRowSchema)

const syncedTabRowSchema = z.object({
  guid: z.string(),
  record: z.string(),
  last_modified: z.number(),
})
const syncedTabRowsSchema = z.array(syncedTabRowSchema)

const syncedTabEntrySchema = z.object({
  title: z.string().nullable().optional(),
  urlHistory: z.array(z.string()),
  lastUsed: z.number(),
})
const syncedTabRecordSchema = z.object({
  clientName: z.string().nullable().optional(),
  tabs: z.array(syncedTabEntrySchema).optional().default([]),
})

const remoteClientsSchema = z.record(
  z.string(),
  z.object({ device_name: z.string().optional() }).passthrough(),
)

const sessionEntrySchema = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
})
const sessionTabSchema = z.object({
  entries: z.array(sessionEntrySchema),
  index: z.number().int().positive(),
  lastAccessed: z.number(),
  pinned: z.boolean().optional(),
})
const sessionWindowSchema = z.object({
  tabs: z.array(sessionTabSchema),
})
const sessionStoreSchema = z.object({
  windows: z.array(sessionWindowSchema),
})

const MOZLZ4_MAGIC = new TextEncoder().encode('mozLz40\0')

function localDateStamp(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function localIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function snapshotSqlite(
  profileDir: string,
  fileName: string,
  stage: 'snapshot' | 'synced_tabs',
): string {
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
  // opening the file. Mirror the original shell exporter: copy main, then
  // -wal so committed-but-uncheckpointed entries are visible; also -shm if
  // present so the next reader can initialize without contention.
  const target = path.join(tmp, fileName)
  try {
    copyFileSync(path.join(profileDir, fileName), target)
    const wal = path.join(profileDir, `${fileName}-wal`)
    if (existsSync(wal)) {
      copyFileSync(wal, `${target}-wal`)
    }
    const shm = path.join(profileDir, `${fileName}-shm`)
    if (existsSync(shm)) {
      copyFileSync(shm, `${target}-shm`)
    }
  } catch (cause) {
    rmSync(tmp, { recursive: true, force: true })
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage,
      reason: `fs copy ${fileName} from ${profileDir}: ${detail}`,
      cause,
    })
  }
  return target
}

function readPlaces(db: Database, since: Date): unknown {
  try {
    return db.query(QUERY_PLACES).all({ $sinceMicros: since.getTime() * 1000 })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'query',
      reason: `reading places.sqlite: ${detail}`,
      cause,
    })
  }
}

function readBookmarks(db: Database): unknown {
  try {
    return db.query(QUERY_BOOKMARKS).all()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'bookmarks',
      reason: `reading moz_bookmarks: ${detail}`,
      cause,
    })
  }
}

function readSyncedTabsRows(db: Database, now: Date): unknown {
  try {
    const ageFloorMs = now.getTime() - SIXTY_DAYS_MS
    return db.query(QUERY_SYNCED_TABS).all({ $ageFloorMs: ageFloorMs })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'synced_tabs',
      reason: `reading tabs: ${detail}`,
      cause,
    })
  }
}

function readRemoteClients(
  db: Database,
): Record<string, { device_name?: string }> {
  let row: unknown
  try {
    row = db
      .query("SELECT value AS v FROM moz_meta WHERE key = 'remote_clients'")
      .get()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'synced_tabs',
      reason: `reading moz_meta.remote_clients: ${detail}`,
      cause,
    })
  }
  if (!row) return {}
  const valueSchema = z.object({ v: z.string() })
  const parsed = valueSchema.safeParse(row)
  if (!parsed.success) return {}
  try {
    return remoteClientsSchema.parse(JSON.parse(parsed.data.v))
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'synced_tabs',
      reason: `parsing remote_clients json: ${detail}`,
      cause,
    })
  }
}

const QUERY_PLACES = `
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

// Other Bookmarks (macOS Cmd+D default) and Mobile Bookmarks (iOS share-sheet
// default) are the two-keystroke / two-tap promotion surfaces.
const QUERY_BOOKMARKS = `
  SELECT
    datetime(b.dateAdded / 1000000, 'unixepoch', 'localtime') AS bookmarked_at,
    p.url AS url,
    COALESCE(NULLIF(b.title, ''), NULLIF(p.title, ''), p.url) AS title,
    b.guid AS guid
  FROM moz_bookmarks b
  JOIN moz_places p ON p.id = b.fk
  JOIN moz_bookmarks f ON f.id = b.parent
  WHERE b.type = 1
    AND f.guid IN ('unfiled_____', 'mobile______')
  ORDER BY b.dateAdded DESC
`

// Sync-broken-then-resigned-in devices leave duplicate "Hex"-style rows; keep
// only the latest per clientName (falling back to guid when null). Drop rows
// older than 60 days so devices the user no longer syncs with disappear.
const QUERY_SYNCED_TABS = `
  WITH ranked AS (
    SELECT
      guid,
      record,
      last_modified,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(json_extract(record, '$.clientName'), guid)
        ORDER BY last_modified DESC
      ) AS rn
    FROM tabs
    WHERE last_modified > $ageFloorMs
  )
  SELECT guid, record, last_modified
  FROM ranked
  WHERE rn = 1
  ORDER BY last_modified DESC
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

type OpenTabRow = {
  last_used: string
  url: string
  title: string
  device: string
  pinned: string
}

function buildOpenTabRows(
  rawRows: unknown,
  remoteClients: Record<string, { device_name?: string }>,
): OpenTabRow[] {
  const rows = syncedTabRowsSchema.parse(rawRows)
  const out: OpenTabRow[] = []
  for (const r of rows) {
    let record: z.infer<typeof syncedTabRecordSchema>
    try {
      record = syncedTabRecordSchema.parse(JSON.parse(r.record))
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new LocalFirefoxFailure({
        stage: 'synced_tabs',
        reason: `parsing tabs.record for ${r.guid}: ${detail}`,
        cause,
      })
    }
    const device =
      record.clientName ?? remoteClients[r.guid]?.device_name ?? r.guid
    for (const tab of record.tabs) {
      if (tab.urlHistory.length === 0) continue
      out.push({
        last_used: localIso(new Date(tab.lastUsed * 1000)),
        url: tab.urlHistory[0]!,
        title: tab.title ?? '',
        device,
        pinned: '',
      })
    }
  }
  return out
}

function readPlacesFromProfile(
  profileDir: string,
  since: Date,
): { places: unknown; bookmarks: unknown } {
  const snapshotPath = snapshotSqlite(profileDir, 'places.sqlite', 'snapshot')
  try {
    let db: Database
    try {
      db = new Database(snapshotPath, { readonly: true })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new LocalFirefoxFailure({
        stage: 'open',
        reason: `opening places.sqlite snapshot: ${detail}`,
        cause,
      })
    }
    try {
      const places = readPlaces(db, since)
      const bookmarks = readBookmarks(db)
      return { places, bookmarks }
    } finally {
      db.close()
    }
  } finally {
    rmSync(path.dirname(snapshotPath), { recursive: true, force: true })
  }
}

function readSyncedTabsFromProfile(profileDir: string): OpenTabRow[] {
  const src = path.join(profileDir, 'synced-tabs.db')
  // Profile may not have synced-tabs.db if Sync was never enabled. Treat
  // as zero-tabs rather than an error.
  if (!existsSync(src)) return []
  const snapshotPath = snapshotSqlite(
    profileDir,
    'synced-tabs.db',
    'synced_tabs',
  )
  try {
    let db: Database
    try {
      db = new Database(snapshotPath, { readonly: true })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new LocalFirefoxFailure({
        stage: 'synced_tabs',
        reason: `opening synced-tabs.db snapshot: ${detail}`,
        cause,
      })
    }
    try {
      const rawRows = readSyncedTabsRows(db, new Date())
      const remoteClients = readRemoteClients(db)
      return buildOpenTabRows(rawRows, remoteClients)
    } finally {
      db.close()
    }
  } finally {
    rmSync(path.dirname(snapshotPath), { recursive: true, force: true })
  }
}

function decodeMozLz4(bytes: Uint8Array): string {
  if (bytes.length < 12) {
    throw new LocalFirefoxFailure({
      stage: 'session_store',
      reason: `file shorter than mozLz4 12-byte header (${bytes.length} bytes)`,
    })
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== MOZLZ4_MAGIC[i]) {
      throw new LocalFirefoxFailure({
        stage: 'session_store',
        reason: `bad mozLz4 magic at offset ${i}`,
      })
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const uncompressedSize = view.getUint32(8, true)
  const dst = new Uint8Array(uncompressedSize)
  const decompressedLen = lz4js.decompressBlock(
    bytes,
    dst,
    12,
    bytes.length - 12,
    0,
  )
  if (decompressedLen !== uncompressedSize) {
    throw new LocalFirefoxFailure({
      stage: 'session_store',
      reason: `lz4 produced ${decompressedLen} bytes, expected ${uncompressedSize}`,
    })
  }
  return new TextDecoder().decode(dst)
}

function readSessionStore(profileDir: string, machine: string): OpenTabRow[] {
  const recovery = path.join(
    profileDir,
    'sessionstore-backups',
    'recovery.jsonlz4',
  )
  const fallback = path.join(profileDir, 'sessionstore.jsonlz4')
  const target = existsSync(recovery)
    ? recovery
    : existsSync(fallback)
      ? fallback
      : null
  if (target === null) return []
  let bytes: Uint8Array
  try {
    bytes = readFileSync(target)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'session_store',
      reason: `read ${target}: ${detail}`,
      cause,
    })
  }
  const json = decodeMozLz4(bytes)
  let parsed: z.infer<typeof sessionStoreSchema>
  try {
    parsed = sessionStoreSchema.parse(JSON.parse(json))
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new LocalFirefoxFailure({
      stage: 'session_store',
      reason: `parsing sessionstore json: ${detail}`,
      cause,
    })
  }
  const rows: OpenTabRow[] = []
  for (const win of parsed.windows) {
    for (const tab of win.tabs) {
      if (tab.entries.length === 0) continue
      // Clamp on the upper bound only — Firefox has had off-by-one bugs where
      // `index` exceeds `entries.length` for newly-opened tabs. Lower bound is
      // enforced by the positive() schema constraint.
      const idx = Math.min(tab.index - 1, tab.entries.length - 1)
      const entry = tab.entries[idx]
      if (!entry) continue
      rows.push({
        last_used: localIso(new Date(tab.lastAccessed)),
        url: entry.url,
        title: entry.title ?? '',
        device: machine,
        pinned: tab.pinned ? '1' : '0',
      })
    }
  }
  return rows
}

export function ingestLocalFirefox(opts: {
  machine: string
  profileDir: string
  blocklistPath?: string
}): Source {
  return {
    machine: opts.machine,
    source: 'firefox',
    pull: async ({ dataDir, since, until }) => {
      const blocklist = loadBlocklist(opts.blocklistPath)
      const now = new Date()
      // Per-day grouping of history rows and the strict `until` upper bound
      // (a `last_visit_date < until` query clause) are deferred to dream-iba4;
      // for now the whole pull lands in the day-bucket of the window's last
      // instant.
      const outDir = path.join(
        dataDir,
        utcDay(new Date(until.getTime() - 1)),
        opts.machine,
        'firefox',
      )
      await mkdir(outDir, { recursive: true })
      const { places: placesRaw, bookmarks: bookmarksRaw } =
        readPlacesFromProfile(opts.profileDir, since)
      const syncedTabs = readSyncedTabsFromProfile(opts.profileDir)
      const localTabs = readSessionStore(opts.profileDir, opts.machine)
      // last_used is ISO `YYYY-MM-DD HH:MM:SS` — lexicographic order matches
      // chronological order, so a string compare sorts the merged list.
      const openTabs = [...localTabs, ...syncedTabs].sort((a, b) =>
        b.last_used.localeCompare(a.last_used),
      )

      const allRows = placeRowsSchema.parse(placesRaw)
      const rows = allRows.filter((r) => !isBlocked(r.url, blocklist))
      const blocklistFiltered = allRows.length - rows.length
      const bookmarkRows = bookmarkRowsSchema.parse(bookmarksRaw)

      const stamp = localDateStamp(now)

      const historyLines = ['visited,url,title,visit_count,frecency,typed']
      for (const r of rows) {
        historyLines.push(
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
      const historyPath = path.join(outDir, `${stamp}.history.csv`)
      await Bun.write(historyPath, historyLines.join('\n') + '\n')

      const bookmarksLines = ['bookmarked_at,url,title,guid']
      for (const b of bookmarkRows) {
        bookmarksLines.push(
          [
            csvField(b.bookmarked_at),
            csvField(b.url),
            csvField(b.title),
            csvField(b.guid),
          ].join(','),
        )
      }
      const bookmarksPath = path.join(outDir, `${stamp}.bookmarks.csv`)
      await Bun.write(bookmarksPath, bookmarksLines.join('\n') + '\n')

      const openTabsLines = ['last_used,url,title,device,pinned']
      for (const t of openTabs) {
        openTabsLines.push(
          [
            csvField(t.last_used),
            csvField(t.url),
            csvField(t.title),
            csvField(t.device),
            csvField(t.pinned),
          ].join(','),
        )
      }
      const openTabsPath = path.join(outDir, `${stamp}.open-tabs.csv`)
      await Bun.write(openTabsPath, openTabsLines.join('\n') + '\n')

      const bytes =
        statSync(historyPath).size +
        statSync(bookmarksPath).size +
        statSync(openTabsPath).size
      return {
        files_pulled: 3,
        bytes,
        rows: rows.length,
        blocklist_filtered: blocklistFiltered,
        bookmark_rows: bookmarkRows.length,
        open_tab_rows: openTabs.length,
      }
    },
  }
}

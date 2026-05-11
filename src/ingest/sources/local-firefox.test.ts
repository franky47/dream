import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as lz4js from 'lz4js'

import { ingestLocalFirefox } from '#src/ingest/sources/local-firefox'

let workDir: string
let profileDir: string
let outDir: string
let placesPath: string
let blocklistPath: string

function writeBlocklist(contents: string): void {
  writeFileSync(blocklistPath, contents)
}

const SINCE = new Date('2026-05-08T00:00:00.000Z')

function microsSinceEpoch(d: Date): number {
  return d.getTime() * 1000
}

type PlaceRow = {
  url: string
  title: string | null
  lastVisit: Date
  visitCount?: number
  frecency?: number
  typed?: number
}

type BookmarkRoot = 'unfiled' | 'mobile' | 'toolbar' | 'menu'

type BookmarkRow = {
  url: string
  title: string | null
  dateAdded: Date
  guid: string
  root: BookmarkRoot
  placeTitle?: string | null
}

const ROOT_ID: Record<BookmarkRoot, number> = {
  unfiled: 1,
  mobile: 2,
  toolbar: 3,
  menu: 4,
}

function readHistoryCsv(): string {
  const files = readdirSync(outDir)
  const file = files.find((f) => f.endsWith('.history.csv'))
  if (!file) throw new Error('no history csv')
  return readFileSync(path.join(outDir, file), 'utf-8')
}

function readBookmarksCsv(): string {
  const files = readdirSync(outDir)
  const file = files.find((f) => f.endsWith('.bookmarks.csv'))
  if (!file) throw new Error('no bookmarks csv')
  return readFileSync(path.join(outDir, file), 'utf-8')
}

function readOpenTabsCsv(): string {
  const files = readdirSync(outDir)
  const file = files.find((f) => f.endsWith('.open-tabs.csv'))
  if (!file) throw new Error('no open-tabs csv')
  return readFileSync(path.join(outDir, file), 'utf-8')
}

type SyncedTabEntry = {
  title?: string
  urlHistory: string[]
  lastUsed: number
}

type SyncedTabRow = {
  guid: string
  clientName: string | null
  lastModified: Date
  tabs: SyncedTabEntry[]
}

type RemoteClient = {
  guid: string
  deviceName: string
}

function createSyncedTabsDb(
  rows: ReadonlyArray<SyncedTabRow>,
  remoteClients: ReadonlyArray<RemoteClient> = [],
): Database {
  const syncedTabsPath = path.join(profileDir, 'synced-tabs.db')
  const db = new Database(syncedTabsPath)
  db.exec(`
    CREATE TABLE tabs (
      guid TEXT PRIMARY KEY,
      record TEXT NOT NULL,
      last_modified INTEGER NOT NULL
    );
    CREATE TABLE moz_meta (
      key TEXT PRIMARY KEY,
      value
    );
  `)
  const insertTab = db.prepare(
    'INSERT INTO tabs (guid, record, last_modified) VALUES (?, ?, ?)',
  )
  for (const r of rows) {
    const record = JSON.stringify({
      clientName: r.clientName,
      tabs: r.tabs,
    })
    insertTab.run(r.guid, record, r.lastModified.getTime())
  }
  if (remoteClients.length > 0) {
    const map: Record<string, { device_name: string }> = {}
    for (const c of remoteClients) {
      map[c.guid] = { device_name: c.deviceName }
    }
    db.prepare('INSERT INTO moz_meta (key, value) VALUES (?, ?)').run(
      'remote_clients',
      JSON.stringify(map),
    )
  }
  return db
}

type LocalTabEntry = {
  url: string
  title?: string
}

type LocalTabInput = {
  entries: LocalTabEntry[]
  index: number
  lastAccessed: number
  pinned?: boolean
}

type LocalWindowInput = {
  tabs: LocalTabInput[]
}

function writeSessionStore(
  filePath: string,
  content: { windows: LocalWindowInput[] },
): void {
  const json = JSON.stringify(content)
  const payload = new TextEncoder().encode(json)
  const hashTable = new Uint32Array(1 << 16)
  const dst = new Uint8Array(lz4js.compressBound(payload.length))
  const compressedLen = lz4js.compressBlock(
    payload,
    dst,
    0,
    payload.length,
    hashTable,
  )
  if (compressedLen === 0) {
    throw new Error('lz4 compressBlock returned 0; payload too small to test')
  }
  const file = new Uint8Array(12 + compressedLen)
  file.set(new TextEncoder().encode('mozLz40\0'), 0)
  new DataView(file.buffer).setUint32(8, payload.length, true)
  file.set(dst.subarray(0, compressedLen), 12)
  writeFileSync(filePath, file)
}

function createPlacesDb(rows: ReadonlyArray<PlaceRow>): Database {
  const db = new Database(placesPath)
  db.exec(`
    CREATE TABLE moz_places (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      last_visit_date INTEGER,
      visit_count INTEGER NOT NULL DEFAULT 0,
      frecency INTEGER NOT NULL DEFAULT -1,
      typed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE moz_bookmarks (
      id INTEGER PRIMARY KEY,
      type INTEGER NOT NULL,
      fk INTEGER,
      parent INTEGER,
      position INTEGER,
      title TEXT,
      dateAdded INTEGER,
      lastModified INTEGER,
      guid TEXT NOT NULL
    );
    INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES
      (1, 2, 0, 0, 'Other Bookmarks', 'unfiled_____'),
      (2, 2, 0, 1, 'Mobile Bookmarks', 'mobile______'),
      (3, 2, 0, 2, 'Toolbar', 'toolbar_____'),
      (4, 2, 0, 3, 'Menu', 'menu________');
  `)
  const insert = db.prepare(
    'INSERT INTO moz_places (url, title, last_visit_date, visit_count, frecency, typed) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const r of rows) {
    insert.run(
      r.url,
      r.title,
      microsSinceEpoch(r.lastVisit),
      r.visitCount ?? 1,
      r.frecency ?? 100,
      r.typed ?? 0,
    )
  }
  return db
}

function insertBookmarks(db: Database, rows: ReadonlyArray<BookmarkRow>): void {
  const insertPlace = db.prepare(
    'INSERT INTO moz_places (url, title, last_visit_date, visit_count, frecency, typed) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const insertBookmark = db.prepare(
    'INSERT INTO moz_bookmarks (type, fk, parent, position, title, dateAdded, guid) VALUES (1, ?, ?, ?, ?, ?, ?)',
  )
  let position = 0
  for (const b of rows) {
    const placeResult = insertPlace.run(
      b.url,
      b.placeTitle ?? null,
      null,
      0,
      -1,
      0,
    )
    insertBookmark.run(
      Number(placeResult.lastInsertRowid),
      ROOT_ID[b.root],
      position++,
      b.title,
      microsSinceEpoch(b.dateAdded),
      b.guid,
    )
  }
}

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-firefox-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  profileDir = path.join(workDir, 'profile')
  outDir = path.join(workDir, 'out')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  placesPath = path.join(profileDir, 'places.sqlite')
  blocklistPath = path.join(workDir, 'blocklist.txt')
  writeFileSync(blocklistPath, '')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('ingestLocalFirefox', () => {
  test('exposes machine and source labels from input', () => {
    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    expect(src.machine).toBe('m4x')
    expect(src.source).toBe('firefox')
  })

  test('uses the supplied machine label', () => {
    const src = ingestLocalFirefox({ machine: 'echo', profileDir })
    expect(src.machine).toBe('echo')
  })

  test('writes one csv with header + in-window rows', async () => {
    const db = createPlacesDb([
      {
        url: 'https://a.example/',
        title: 'A',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    const files = readdirSync(outDir).sort()
    expect(files).toHaveLength(3)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.bookmarks\.csv$/)
    expect(files[1]).toMatch(/^\d{4}-\d{2}-\d{2}\.history\.csv$/)
    expect(files[2]).toMatch(/^\d{4}-\d{2}-\d{2}\.open-tabs\.csv$/)
    const csv = readHistoryCsv()
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('visited,url,title,visit_count,frecency,typed')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('https://a.example/')
    expect(lines[1]).toContain('A')
    expect(metrics.rows).toBe(1)
    expect(metrics.files_pulled).toBe(3)
  })

  test('surfaces visit_count, frecency, typed columns from moz_places', async () => {
    const db = createPlacesDb([
      {
        url: 'https://typed.example/',
        title: 'typed url',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
        visitCount: 17,
        frecency: 4321,
        typed: 1,
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(2)
    const cells = lines[1]!.split(',')
    expect(cells[1]).toBe('https://typed.example/')
    expect(cells[2]).toBe('typed url')
    expect(cells[3]).toBe('17')
    expect(cells[4]).toBe('4321')
    expect(cells[5]).toBe('1')
  })

  test('aggregates visit_count across query-string variants grouped under one url', async () => {
    const db = createPlacesDb([
      {
        url: 'https://agg.example/page?a=1',
        title: 'variant a',
        lastVisit: new Date('2026-05-09T08:00:00Z'),
        visitCount: 3,
        frecency: 100,
        typed: 0,
      },
      {
        url: 'https://agg.example/page?b=2',
        title: 'variant b',
        lastVisit: new Date('2026-05-09T09:00:00Z'),
        visitCount: 5,
        frecency: 900,
        typed: 1,
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    const lines = csv.trim().split('\n')
    expect(metrics.rows).toBe(1)
    const cells = lines[1]!.split(',')
    expect(cells[1]).toBe('https://agg.example/page')
    // visit_count: SUM across variants
    expect(cells[3]).toBe('8')
    // frecency: MAX across variants
    expect(cells[4]).toBe('900')
    // typed: MAX (any variant typed)
    expect(cells[5]).toBe('1')
  })

  test('excludes URLs visited before the since cutoff', async () => {
    const db = createPlacesDb([
      {
        url: 'https://recent.example/',
        title: 'recent',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
      {
        url: 'https://old.example/',
        title: 'old',
        lastVisit: new Date('2026-05-01T12:00:00Z'),
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).toContain('https://recent.example/')
    expect(csv).not.toContain('https://old.example/')
    expect(metrics.rows).toBe(1)
  })

  test('collapses duplicate URLs and keeps the most recent visit', async () => {
    const db = createPlacesDb([
      {
        url: 'https://dup.example/',
        title: 'first',
        lastVisit: new Date('2026-05-09T08:00:00Z'),
      },
      {
        url: 'https://dup.example/',
        title: 'last',
        lastVisit: new Date('2026-05-09T20:00:00Z'),
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    const metrics = await src.pull({ outDir, since: SINCE })
    expect(metrics.rows).toBe(1)
  })

  test('strips query strings before grouping', async () => {
    const db = createPlacesDb([
      {
        url: 'https://q.example/path?a=1',
        title: 't1',
        lastVisit: new Date('2026-05-09T08:00:00Z'),
      },
      {
        url: 'https://q.example/path?b=2',
        title: 't2',
        lastVisit: new Date('2026-05-09T09:00:00Z'),
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).toContain('https://q.example/path')
    expect(csv).not.toContain('a=1')
    expect(csv).not.toContain('b=2')
    expect(metrics.rows).toBe(1)
  })

  test('strips fragments before grouping', async () => {
    const db = createPlacesDb([
      {
        url: 'https://f.example/page#section-1',
        title: 't1',
        lastVisit: new Date('2026-05-09T08:00:00Z'),
      },
      {
        url: 'https://f.example/page#section-2',
        title: 't2',
        lastVisit: new Date('2026-05-09T09:00:00Z'),
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).toContain('https://f.example/page')
    expect(csv).not.toContain('section-1')
    expect(csv).not.toContain('section-2')
    expect(metrics.rows).toBe(1)
  })

  test('csv-escapes titles containing commas, quotes, and newlines', async () => {
    const db = createPlacesDb([
      {
        url: 'https://e.example/',
        title: 'a, "b" \nc',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
    ])
    db.close()

    const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
    await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).toContain('"a, ""b"" \nc"')
  })

  test('snapshot lets pull succeed while a writer holds the original db open', async () => {
    const db = createPlacesDb([
      {
        url: 'https://locked.example/',
        title: 'open',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
    ])
    // intentionally do not close — simulates Firefox running
    try {
      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      const metrics = await src.pull({ outDir, since: SINCE })
      expect(metrics.rows).toBe(1)
      const csv = readHistoryCsv()
      expect(csv).toContain('https://locked.example/')
    } finally {
      db.close()
    }
  })

  test('drops rows whose host exactly matches a blocklist entry', async () => {
    const db = createPlacesDb([
      {
        url: 'https://twitter.com/home',
        title: 'twitter',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
      {
        url: 'https://example.com/keep',
        title: 'keep',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
    ])
    db.close()
    writeBlocklist('twitter.com\n')

    const src = ingestLocalFirefox({
      machine: 'm4x',
      profileDir,
      blocklistPath,
    })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).not.toContain('twitter.com')
    expect(csv).toContain('example.com/keep')
    expect(metrics.rows).toBe(1)
    expect(metrics.blocklist_filtered).toBe(1)
  })

  test('drops rows whose host is a subdomain of a blocklist entry', async () => {
    const db = createPlacesDb([
      {
        url: 'https://m.twitter.com/feed',
        title: 'mobile twitter',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
      {
        url: 'https://nottwitter.com/keep',
        title: 'unrelated',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
    ])
    db.close()
    writeBlocklist('twitter.com\n')

    const src = ingestLocalFirefox({
      machine: 'm4x',
      profileDir,
      blocklistPath,
    })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).not.toContain('m.twitter.com')
    expect(csv).toContain('nottwitter.com')
    expect(metrics.rows).toBe(1)
    expect(metrics.blocklist_filtered).toBe(1)
  })

  test('ignores comments and blank lines in the blocklist file', async () => {
    const db = createPlacesDb([
      {
        url: 'https://blocked.example/x',
        title: 'b',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
      {
        url: 'https://kept.example/y',
        title: 'k',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
    ])
    db.close()
    writeBlocklist(
      [
        '# top comment',
        '',
        'blocked.example  # trailing comment',
        '   ',
        '# kept.example is intentionally not blocklisted',
      ].join('\n') + '\n',
    )

    const src = ingestLocalFirefox({
      machine: 'm4x',
      profileDir,
      blocklistPath,
    })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).not.toContain('blocked.example')
    expect(csv).toContain('kept.example/y')
    expect(metrics.blocklist_filtered).toBe(1)
  })

  test('blocklist_filtered equals number of dropped rows', async () => {
    const db = createPlacesDb([
      {
        url: 'https://a.bad.example/1',
        title: 'a',
        lastVisit: new Date('2026-05-09T08:00:00Z'),
      },
      {
        url: 'https://m.bad.example/2',
        title: 'b',
        lastVisit: new Date('2026-05-09T09:00:00Z'),
      },
      {
        url: 'https://bad.example/3',
        title: 'c',
        lastVisit: new Date('2026-05-09T10:00:00Z'),
      },
      {
        url: 'https://good.example/4',
        title: 'd',
        lastVisit: new Date('2026-05-09T11:00:00Z'),
      },
    ])
    db.close()
    writeBlocklist('bad.example\n')

    const src = ingestLocalFirefox({
      machine: 'm4x',
      profileDir,
      blocklistPath,
    })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(metrics.rows).toBe(1)
    expect(metrics.blocklist_filtered).toBe(3)
  })

  test('rows whose url has no parseable host are kept and not counted as filtered', async () => {
    // about:blank-style and other host-less schemes parse to hostname '' —
    // they shouldn't match a real-domain blocklist entry. Locks in the
    // fail-open semantics of isBlocked.
    const db = createPlacesDb([
      {
        url: 'about:blank',
        title: 'blank',
        lastVisit: new Date('2026-05-09T08:00:00Z'),
      },
      {
        url: 'https://blocked.example/x',
        title: 'b',
        lastVisit: new Date('2026-05-09T09:00:00Z'),
      },
    ])
    db.close()
    writeBlocklist('blocked.example\n')

    const src = ingestLocalFirefox({
      machine: 'm4x',
      profileDir,
      blocklistPath,
    })
    const metrics = await src.pull({ outDir, since: SINCE })

    const csv = readHistoryCsv()
    expect(csv).toContain('about:blank')
    expect(csv).not.toContain('blocked.example')
    expect(metrics.rows).toBe(1)
    expect(metrics.blocklist_filtered).toBe(1)
  })

  test('blocklist_filtered is 0 when no rows match', async () => {
    const db = createPlacesDb([
      {
        url: 'https://a.example/1',
        title: 'a',
        lastVisit: new Date('2026-05-09T08:00:00Z'),
      },
      {
        url: 'https://b.example/2',
        title: 'b',
        lastVisit: new Date('2026-05-09T09:00:00Z'),
      },
    ])
    db.close()
    writeBlocklist('# nothing blocked\n')

    const src = ingestLocalFirefox({
      machine: 'm4x',
      profileDir,
      blocklistPath,
    })
    const metrics = await src.pull({ outDir, since: SINCE })

    expect(metrics.rows).toBe(2)
    expect(metrics.blocklist_filtered).toBe(0)
  })

  test('pull succeeds against a WAL+EXCLUSIVE-locked db (Firefox-style)', async () => {
    const db = createPlacesDb([
      {
        url: 'https://wal-locked.example/',
        title: 'firefox-style',
        lastVisit: new Date('2026-05-09T12:00:00Z'),
      },
    ])
    db.run('PRAGMA journal_mode=WAL')
    db.run('PRAGMA locking_mode=EXCLUSIVE')
    // force the exclusive lock to actually be acquired by performing a write
    db.prepare(
      'INSERT INTO moz_places (url, title, last_visit_date, visit_count, frecency, typed) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'https://force-lock.example/',
      'forced',
      new Date('2026-05-09T13:00:00Z').getTime() * 1000,
      1,
      100,
      0,
    )
    try {
      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      const metrics = await src.pull({ outDir, since: SINCE })
      expect(metrics.rows).toBeGreaterThanOrEqual(1)
      const csv = readHistoryCsv()
      expect(csv).toContain('https://wal-locked.example/')
    } finally {
      db.close()
    }
  })

  describe('bookmarks CSV', () => {
    test('emits header-only bookmarks csv when no bookmarks exist', async () => {
      const db = createPlacesDb([])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      const metrics = await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      expect(csv.trim()).toBe('bookmarked_at,url,title,guid')
      expect(metrics.files_pulled).toBe(3)
    })

    test('surfaces a bookmark under Other Bookmarks (unfiled_____)', async () => {
      const db = createPlacesDb([])
      insertBookmarks(db, [
        {
          url: 'https://promoted.example/article',
          title: 'promoted',
          dateAdded: new Date('2026-05-09T10:00:00Z'),
          guid: 'aaaaaaaaaaaa',
          root: 'unfiled',
        },
      ])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      const lines = csv.trim().split('\n')
      expect(lines[0]).toBe('bookmarked_at,url,title,guid')
      expect(lines).toHaveLength(2)
      const cells = lines[1]!.split(',')
      expect(cells[1]).toBe('https://promoted.example/article')
      expect(cells[2]).toBe('promoted')
      expect(cells[3]).toBe('aaaaaaaaaaaa')
    })

    test('surfaces a bookmark under Mobile Bookmarks (mobile______)', async () => {
      const db = createPlacesDb([])
      insertBookmarks(db, [
        {
          url: 'https://ios-promoted.example/',
          title: 'ios share-sheet',
          dateAdded: new Date('2026-05-09T11:00:00Z'),
          guid: 'mobileguid01',
          root: 'mobile',
        },
      ])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      expect(csv).toContain('https://ios-promoted.example/')
      expect(csv).toContain('mobileguid01')
    })

    test('excludes children of toolbar_____ and menu________', async () => {
      const db = createPlacesDb([])
      insertBookmarks(db, [
        {
          url: 'https://toolbar.example/',
          title: 'toolbar bookmark',
          dateAdded: new Date('2026-05-09T12:00:00Z'),
          guid: 'toolbarguid1',
          root: 'toolbar',
        },
        {
          url: 'https://menu.example/',
          title: 'menu bookmark',
          dateAdded: new Date('2026-05-09T13:00:00Z'),
          guid: 'menuguid0001',
          root: 'menu',
        },
        {
          url: 'https://kept.example/',
          title: 'kept',
          dateAdded: new Date('2026-05-09T14:00:00Z'),
          guid: 'keptguid0001',
          root: 'unfiled',
        },
      ])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      expect(csv).not.toContain('toolbar.example')
      expect(csv).not.toContain('menu.example')
      expect(csv).toContain('https://kept.example/')
    })

    test('bookmarked_at is local ISO YYYY-MM-DD HH:MM:SS', async () => {
      const db = createPlacesDb([])
      insertBookmarks(db, [
        {
          url: 'https://time.example/',
          title: 't',
          dateAdded: new Date('2026-05-09T15:30:45Z'),
          guid: 'timeguid0001',
          root: 'unfiled',
        },
      ])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      const lines = csv.trim().split('\n')
      const cells = lines[1]!.split(',')
      expect(cells[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    })

    test('title falls back to place title when bookmark title is NULL', async () => {
      const db = createPlacesDb([])
      insertBookmarks(db, [
        {
          url: 'https://fallback.example/',
          title: null,
          placeTitle: 'place-provided title',
          dateAdded: new Date('2026-05-09T16:00:00Z'),
          guid: 'fallbackguid',
          root: 'unfiled',
        },
      ])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      const lines = csv.trim().split('\n')
      const cells = lines[1]!.split(',')
      expect(cells[2]).toBe('place-provided title')
    })

    test('title falls back to URL when both bookmark and place titles are NULL/empty', async () => {
      const db = createPlacesDb([])
      insertBookmarks(db, [
        {
          url: 'https://no-title.example/x',
          title: null,
          placeTitle: null,
          dateAdded: new Date('2026-05-09T17:00:00Z'),
          guid: 'notitleguid1',
          root: 'unfiled',
        },
      ])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      const lines = csv.trim().split('\n')
      const cells = lines[1]!.split(',')
      expect(cells[2]).toBe('https://no-title.example/x')
    })

    test('treats empty-string titles the same as NULL in the fallback chain', async () => {
      const db = createPlacesDb([])
      insertBookmarks(db, [
        {
          url: 'https://empty.example/a',
          title: '',
          placeTitle: 'place-title-survives',
          dateAdded: new Date('2026-05-09T18:00:00Z'),
          guid: 'emptyguid001',
          root: 'unfiled',
        },
        {
          url: 'https://empty.example/b',
          title: '',
          placeTitle: '',
          dateAdded: new Date('2026-05-09T19:00:00Z'),
          guid: 'emptyguid002',
          root: 'unfiled',
        },
      ])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readBookmarksCsv()
      const lines = csv.trim().split('\n')
      const rowsByGuid = new Map(
        lines.slice(1).map((line) => {
          const cells = line.split(',')
          return [cells[3]!, cells[2]!] as const
        }),
      )
      expect(rowsByGuid.get('emptyguid001')).toBe('place-title-survives')
      expect(rowsByGuid.get('emptyguid002')).toBe('https://empty.example/b')
    })

    test('blocklist is not applied to bookmarks', async () => {
      const db = createPlacesDb([
        {
          url: 'https://twitter.com/feed',
          title: 'twitter feed',
          lastVisit: new Date('2026-05-09T08:00:00Z'),
        },
      ])
      insertBookmarks(db, [
        {
          url: 'https://twitter.com/saved-thread',
          title: 'saved thread',
          dateAdded: new Date('2026-05-09T18:00:00Z'),
          guid: 'twitterguid1',
          root: 'unfiled',
        },
      ])
      db.close()
      writeBlocklist('twitter.com\n')

      const src = ingestLocalFirefox({
        machine: 'm4x',
        profileDir,
        blocklistPath,
      })
      await src.pull({ outDir, since: SINCE })

      const historyCsv = readHistoryCsv()
      const bookmarksCsv = readBookmarksCsv()
      expect(historyCsv).not.toContain('twitter.com')
      expect(bookmarksCsv).toContain('twitter.com/saved-thread')
    })

    test('bookmark failure surfaces as LocalFirefoxFailure with stage=bookmarks', async () => {
      const db = createPlacesDb([])
      db.run('DROP TABLE moz_bookmarks')
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      let caught: unknown
      try {
        await src.pull({ outDir, since: SINCE })
      } catch (e) {
        caught = e
      }
      expect(caught).toMatchObject({
        name: 'LocalFirefoxFailure',
        stage: 'bookmarks',
      })
    })
  })

  describe('open-tabs CSV', () => {
    const HOUR_MS = 60 * 60 * 1000
    const DAY_MS = 24 * HOUR_MS

    test('emits header-only csv when synced-tabs.db is missing entirely', async () => {
      const db = createPlacesDb([])
      db.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      const metrics = await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv.trim()).toBe('last_used,url,title,device,pinned')
      expect(metrics.files_pulled).toBe(3)
    })

    test('emits header-only csv when the tabs table is empty', async () => {
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv.trim()).toBe('last_used,url,title,device,pinned')
    })

    test('surfaces tabs from one device with clientName as device label', async () => {
      const recentMs = Date.now() - HOUR_MS
      const lastUsed = Math.floor(recentMs / 1000)
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'iphoneguid01',
          clientName: 'François iPhone',
          lastModified: new Date(recentMs),
          tabs: [
            {
              title: 'Long read',
              urlHistory: ['https://example.com/long-read'],
              lastUsed,
            },
          ],
        },
      ])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      const lines = csv.trim().split('\n')
      expect(lines[0]).toBe('last_used,url,title,device,pinned')
      expect(lines).toHaveLength(2)
      const cells = lines[1]!.split(',')
      expect(cells[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(cells[1]).toBe('https://example.com/long-read')
      expect(cells[2]).toBe('Long read')
      expect(cells[3]).toBe('François iPhone')
      expect(cells[4]).toBe('')
    })

    test('device falls back to moz_meta.remote_clients when clientName is null', async () => {
      const recentMs = Date.now() - HOUR_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb(
        [
          {
            guid: 'devguid00001',
            clientName: null,
            lastModified: new Date(recentMs),
            tabs: [
              {
                title: 't',
                urlHistory: ['https://example.com/'],
                lastUsed: Math.floor(recentMs / 1000),
              },
            ],
          },
        ],
        [{ guid: 'devguid00001', deviceName: 'Hex Desktop' }],
      )
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('Hex Desktop')
    })

    test('device falls back to guid when both clientName and remote_clients are missing', async () => {
      const recentMs = Date.now() - HOUR_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'orphanguid00',
          clientName: null,
          lastModified: new Date(recentMs),
          tabs: [
            {
              title: 't',
              urlHistory: ['https://example.com/'],
              lastUsed: Math.floor(recentMs / 1000),
            },
          ],
        },
      ])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      const lines = csv.trim().split('\n')
      const cells = lines[1]!.split(',')
      expect(cells[3]).toBe('orphanguid00')
    })

    test('drops rows whose last_modified is more than 60 days ago', async () => {
      const recentMs = Date.now() - HOUR_MS
      const ancientMs = Date.now() - 100 * DAY_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'ancientguid1',
          clientName: 'Old Mac',
          lastModified: new Date(ancientMs),
          tabs: [
            {
              title: 'old',
              urlHistory: ['https://ancient.example/'],
              lastUsed: Math.floor(ancientMs / 1000),
            },
          ],
        },
        {
          guid: 'recentguid01',
          clientName: 'Current Mac',
          lastModified: new Date(recentMs),
          tabs: [
            {
              title: 'now',
              urlHistory: ['https://current.example/'],
              lastUsed: Math.floor(recentMs / 1000),
            },
          ],
        },
      ])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).not.toContain('ancient.example')
      expect(csv).toContain('current.example')
    })

    test('keeps only the latest row per clientName (Sync re-signed dedup)', async () => {
      const newerMs = Date.now() - HOUR_MS
      const olderMs = Date.now() - 5 * DAY_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'stale-iphone',
          clientName: 'François iPhone',
          lastModified: new Date(olderMs),
          tabs: [
            {
              title: 'stale',
              urlHistory: ['https://stale.example/'],
              lastUsed: Math.floor(olderMs / 1000),
            },
          ],
        },
        {
          guid: 'active-iphone',
          clientName: 'François iPhone',
          lastModified: new Date(newerMs),
          tabs: [
            {
              title: 'fresh',
              urlHistory: ['https://fresh.example/'],
              lastUsed: Math.floor(newerMs / 1000),
            },
          ],
        },
      ])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).not.toContain('stale.example')
      expect(csv).toContain('fresh.example')
    })

    test('null clientName uses guid for dedup grouping (not all-NULL collapse)', async () => {
      const aMs = Date.now() - 2 * HOUR_MS
      const bMs = Date.now() - HOUR_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'aaaaaaaaaaaa',
          clientName: null,
          lastModified: new Date(aMs),
          tabs: [
            {
              title: 'a',
              urlHistory: ['https://a.example/'],
              lastUsed: Math.floor(aMs / 1000),
            },
          ],
        },
        {
          guid: 'bbbbbbbbbbbb',
          clientName: null,
          lastModified: new Date(bMs),
          tabs: [
            {
              title: 'b',
              urlHistory: ['https://b.example/'],
              lastUsed: Math.floor(bMs / 1000),
            },
          ],
        },
      ])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('a.example')
      expect(csv).toContain('b.example')
    })

    test('skips tabs whose urlHistory is empty', async () => {
      const recentMs = Date.now() - HOUR_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'mixedguid001',
          clientName: 'Mixed Device',
          lastModified: new Date(recentMs),
          tabs: [
            {
              title: 'good',
              urlHistory: ['https://good.example/'],
              lastUsed: Math.floor(recentMs / 1000),
            },
            {
              title: 'empty',
              urlHistory: [],
              lastUsed: Math.floor(recentMs / 1000),
            },
          ],
        },
      ])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      const lines = csv.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[1]).toContain('https://good.example/')
    })

    test('uses urlHistory[0] as the current URL', async () => {
      const recentMs = Date.now() - HOUR_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'historyguid1',
          clientName: 'Device',
          lastModified: new Date(recentMs),
          tabs: [
            {
              title: 't',
              urlHistory: [
                'https://current.example/',
                'https://previous.example/',
              ],
              lastUsed: Math.floor(recentMs / 1000),
            },
          ],
        },
      ])
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('https://current.example/')
      expect(csv).not.toContain('previous.example')
    })

    test('synced_tabs failure surfaces as LocalFirefoxFailure with stage=synced_tabs', async () => {
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([])
      tabs.run('DROP TABLE tabs')
      tabs.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      let caught: unknown
      try {
        await src.pull({ outDir, since: SINCE })
      } catch (e) {
        caught = e
      }
      expect(caught).toMatchObject({
        name: 'LocalFirefoxFailure',
        stage: 'synced_tabs',
      })
    })

    test('pull succeeds while a writer holds synced-tabs.db open', async () => {
      const recentMs = Date.now() - HOUR_MS
      const places = createPlacesDb([])
      places.close()
      const tabs = createSyncedTabsDb([
        {
          guid: 'lockedguid01',
          clientName: 'Locked Device',
          lastModified: new Date(recentMs),
          tabs: [
            {
              title: 'locked',
              urlHistory: ['https://locked-sync.example/'],
              lastUsed: Math.floor(recentMs / 1000),
            },
          ],
        },
      ])
      tabs.run('PRAGMA journal_mode=WAL')
      tabs.run('PRAGMA locking_mode=EXCLUSIVE')
      tabs
        .prepare(
          'INSERT INTO tabs (guid, record, last_modified) VALUES (?, ?, ?)',
        )
        .run(
          'forceguid0001',
          JSON.stringify({ clientName: 'Forcer', tabs: [] }),
          Date.now(),
        )
      try {
        const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
        await src.pull({ outDir, since: SINCE })
        const csv = readOpenTabsCsv()
        expect(csv).toContain('locked-sync.example')
      } finally {
        tabs.close()
      }
    })
  })

  describe('local-tabs session store', () => {
    const HOUR_MS = 60 * 60 * 1000

    function sessionStorePath(): string {
      return path.join(profileDir, 'sessionstore.jsonlz4')
    }

    function recoveryPath(): string {
      const dir = path.join(profileDir, 'sessionstore-backups')
      mkdirSync(dir, { recursive: true })
      return path.join(dir, 'recovery.jsonlz4')
    }

    test('emits no local rows when both jsonlz4 files are absent', async () => {
      const places = createPlacesDb([])
      places.close()

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv.trim()).toBe('last_used,url,title,device,pinned')
    })

    test('surfaces tab from sessionstore.jsonlz4 with device=machine', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(sessionStorePath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://local.example/', title: 'Local' }],
                index: 1,
                lastAccessed,
                pinned: false,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      const lines = csv.trim().split('\n')
      expect(lines).toHaveLength(2)
      const cells = lines[1]!.split(',')
      expect(cells[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(cells[1]).toBe('https://local.example/')
      expect(cells[2]).toBe('Local')
      expect(cells[3]).toBe('m4x')
      expect(cells[4]).toBe('0')
    })

    test('prefers sessionstore-backups/recovery.jsonlz4 over sessionstore.jsonlz4', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(sessionStorePath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://stale.example/', title: 'stale' }],
                index: 1,
                lastAccessed,
              },
            ],
          },
        ],
      })
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://fresh.example/', title: 'fresh' }],
                index: 1,
                lastAccessed,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('https://fresh.example/')
      expect(csv).not.toContain('stale.example')
    })

    test('falls back to sessionstore.jsonlz4 when recovery is absent', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(sessionStorePath(), {
        windows: [
          {
            tabs: [
              {
                entries: [
                  { url: 'https://only-shutdown.example/', title: 't' },
                ],
                index: 1,
                lastAccessed,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('https://only-shutdown.example/')
    })

    test('picks entries[index - 1] as the current entry', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [
                  { url: 'https://oldest.example/', title: 'oldest' },
                  { url: 'https://current.example/', title: 'current' },
                  { url: 'https://forward.example/', title: 'forward' },
                ],
                index: 2,
                lastAccessed,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('https://current.example/')
      expect(csv).not.toContain('oldest.example')
      expect(csv).not.toContain('forward.example')
    })

    test('flattens tabs across multiple windows', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://win1.example/', title: 'w1' }],
                index: 1,
                lastAccessed,
              },
            ],
          },
          {
            tabs: [
              {
                entries: [{ url: 'https://win2.example/', title: 'w2' }],
                index: 1,
                lastAccessed,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('https://win1.example/')
      expect(csv).toContain('https://win2.example/')
    })

    test('pinned tabs emit pinned=1, others emit 0', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://pinned.example/', title: 'p' }],
                index: 1,
                lastAccessed,
                pinned: true,
              },
              {
                entries: [{ url: 'https://unpinned.example/', title: 'u' }],
                index: 1,
                lastAccessed,
                pinned: false,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      const lines = csv.trim().split('\n')
      const byUrl = new Map(
        lines.slice(1).map((l) => {
          const c = l.split(',')
          return [c[1]!, c[4]!] as const
        }),
      )
      expect(byUrl.get('https://pinned.example/')).toBe('1')
      expect(byUrl.get('https://unpinned.example/')).toBe('0')
    })

    test('skips tabs whose entries[] array is empty', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [],
                index: 1,
                lastAccessed,
              },
              {
                entries: [{ url: 'https://good.example/', title: 'good' }],
                index: 1,
                lastAccessed,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      const lines = csv.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[1]).toContain('https://good.example/')
    })

    test('rejects records with index=0 (1-based field; 0 means corruption)', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://x.example/', title: 'x' }],
                index: 0,
                lastAccessed,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      let caught: unknown
      try {
        await src.pull({ outDir, since: SINCE })
      } catch (e) {
        caught = e
      }
      expect(caught).toMatchObject({
        name: 'LocalFirefoxFailure',
        stage: 'session_store',
      })
    })

    test('clamps an out-of-range index to the last entry', async () => {
      const places = createPlacesDb([])
      places.close()
      const lastAccessed = Date.now() - HOUR_MS
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [
                  { url: 'https://first.example/', title: 'first' },
                  { url: 'https://second.example/', title: 'second' },
                ],
                index: 99,
                lastAccessed,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('https://second.example/')
      expect(csv).not.toContain('first.example')
    })

    test('rejects file without the mozLz40 magic header', async () => {
      const places = createPlacesDb([])
      places.close()
      writeFileSync(sessionStorePath(), Buffer.from('not lz4 data at all'))

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      let caught: unknown
      try {
        await src.pull({ outDir, since: SINCE })
      } catch (e) {
        caught = e
      }
      expect(caught).toMatchObject({
        name: 'LocalFirefoxFailure',
        stage: 'session_store',
      })
    })

    test('local and synced rows appear together in the same CSV', async () => {
      const places = createPlacesDb([])
      places.close()
      const recent = Date.now() - HOUR_MS
      createSyncedTabsDb([
        {
          guid: 'syncedguid001',
          clientName: 'iPhone',
          lastModified: new Date(recent),
          tabs: [
            {
              title: 'remote',
              urlHistory: ['https://remote.example/'],
              lastUsed: Math.floor(recent / 1000),
            },
          ],
        },
      ]).close()
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://local.example/', title: 'local' }],
                index: 1,
                lastAccessed: recent,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      expect(csv).toContain('https://remote.example/')
      expect(csv).toContain('https://local.example/')
      expect(csv).toContain('m4x')
      expect(csv).toContain('iPhone')
    })

    test('merged CSV is ordered by last_used descending across local and synced rows', async () => {
      const places = createPlacesDb([])
      places.close()
      const newestMs = Date.now() - HOUR_MS
      const middleMs = Date.now() - 3 * HOUR_MS
      const oldestMs = Date.now() - 5 * HOUR_MS
      createSyncedTabsDb([
        {
          guid: 'syncednewest',
          clientName: 'iPhone',
          lastModified: new Date(newestMs),
          tabs: [
            {
              title: 'newest',
              urlHistory: ['https://newest.example/'],
              lastUsed: Math.floor(newestMs / 1000),
            },
          ],
        },
        {
          guid: 'syncedoldest',
          clientName: 'iPad',
          lastModified: new Date(oldestMs),
          tabs: [
            {
              title: 'oldest',
              urlHistory: ['https://oldest.example/'],
              lastUsed: Math.floor(oldestMs / 1000),
            },
          ],
        },
      ]).close()
      writeSessionStore(recoveryPath(), {
        windows: [
          {
            tabs: [
              {
                entries: [{ url: 'https://middle.example/', title: 'middle' }],
                index: 1,
                lastAccessed: middleMs,
              },
            ],
          },
        ],
      })

      const src = ingestLocalFirefox({ machine: 'm4x', profileDir })
      await src.pull({ outDir, since: SINCE })

      const csv = readOpenTabsCsv()
      const lines = csv.trim().split('\n').slice(1)
      const urls = lines.map((l) => l.split(',')[1]!)
      expect(urls).toEqual([
        'https://newest.example/',
        'https://middle.example/',
        'https://oldest.example/',
      ])
    })
  })
})

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
    expect(files).toHaveLength(2)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.bookmarks\.csv$/)
    expect(files[1]).toMatch(/^\d{4}-\d{2}-\d{2}\.history\.csv$/)
    const csv = readHistoryCsv()
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('visited,url,title,visit_count,frecency,typed')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('https://a.example/')
    expect(lines[1]).toContain('A')
    expect(metrics.rows).toBe(1)
    expect(metrics.files_pulled).toBe(2)
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
      expect(metrics.files_pulled).toBe(2)
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
})

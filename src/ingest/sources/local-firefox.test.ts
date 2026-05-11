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

    const files = readdirSync(outDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.history\.csv$/)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('visited,url,title,visit_count,frecency,typed')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('https://a.example/')
    expect(lines[1]).toContain('A')
    expect(metrics.rows).toBe(1)
    expect(metrics.files_pulled).toBe(1)
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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
      const files = readdirSync(outDir)
      const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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

    const files = readdirSync(outDir)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
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
      const files = readdirSync(outDir)
      const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
      expect(csv).toContain('https://wal-locked.example/')
    } finally {
      db.close()
    }
  })
})

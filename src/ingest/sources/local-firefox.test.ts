import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ingestLocalFirefox } from '#src/ingest/sources/local-firefox'

let workDir: string
let profileDir: string
let outDir: string
let placesPath: string

const SINCE = new Date('2026-05-08T00:00:00.000Z')

function microsSinceEpoch(d: Date): number {
  return d.getTime() * 1000
}

type PlaceRow = {
  url: string
  title: string | null
  lastVisit: Date
}

function createPlacesDb(rows: ReadonlyArray<PlaceRow>): Database {
  const db = new Database(placesPath)
  db.exec(`
    CREATE TABLE moz_places (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      last_visit_date INTEGER
    );
  `)
  const insert = db.prepare(
    'INSERT INTO moz_places (url, title, last_visit_date) VALUES (?, ?, ?)',
  )
  for (const r of rows) {
    insert.run(r.url, r.title, microsSinceEpoch(r.lastVisit))
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
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.csv$/)
    const csv = readFileSync(path.join(outDir, files[0]!), 'utf-8')
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('visited,url,title')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('https://a.example/')
    expect(lines[1]).toContain('A')
    expect(metrics.rows).toBe(1)
    expect(metrics.files_pulled).toBe(1)
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
})

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { ingestLocalOpencode } from '#src/ingest/sources/local-opencode'

const rowSchema = z.record(z.string(), z.unknown())

let workDir: string
let dbPath: string
let outDir: string

const SCHEMA_STATEMENTS = [
  `CREATE TABLE project (
    id TEXT PRIMARY KEY,
    worktree TEXT NOT NULL,
    vcs TEXT,
    name TEXT,
    icon_url TEXT,
    icon_color TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_initialized INTEGER,
    sandboxes TEXT NOT NULL,
    commands TEXT,
    icon_url_override TEXT
  )`,
  `CREATE TABLE workspace (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    branch TEXT,
    directory TEXT,
    extra TEXT,
    project_id TEXT NOT NULL
  )`,
  `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    workspace_id TEXT,
    path TEXT
  )`,
  `CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
]

function seedDb(): void {
  const db = new Database(dbPath, { create: true })
  for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run()
  db.prepare(
    `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
     VALUES ('prj_a', '/repo', 'git', 'dream', 0, 0, '[]')`,
  ).run()
  db.prepare(
    `INSERT INTO workspace (id, type, name, branch, directory, project_id)
     VALUES ('wks_a', 'local', '', 'main', '/repo', 'prj_a')`,
  ).run()
  db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, workspace_id)
     VALUES ('ses_1', 'prj_a', 'slug', '/repo', 'hi', '0.x', 5000, 9000, 'wks_a')`,
  ).run()
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, workspace_id)
     VALUES ('ses_child', 'prj_a', 'ses_1', 'slug', '/repo', 'child', '0.x', 6000, 9000, 'wks_a')`,
  ).run()
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES ('msg_1', 'ses_1', 6000, 6000, '{"role":"user"}')`,
  ).run()
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES ('msg_child', 'ses_child', 7000, 7000, '{"role":"user"}')`,
  ).run()
  db.close()
}

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-local-opencode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  dbPath = path.join(workDir, 'opencode.db')
  outDir = path.join(workDir, 'out')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('ingestLocalOpencode', () => {
  test('exposes machine + source labels', () => {
    const src = ingestLocalOpencode({ machine: 'm4x', dbPath })
    expect(src.machine).toBe('m4x')
    expect(src.source).toBe('opencode')
  })

  test('writes a per-session jsonl with header + message, subagents excluded', async () => {
    seedDb()
    const src = ingestLocalOpencode({ machine: 'm4x', dbPath })
    const metrics = await src.pull({ outDir, since: new Date(0) })

    expect(readdirSync(outDir).sort()).toEqual(['ses_1.jsonl'])
    const content = readFileSync(path.join(outDir, 'ses_1.jsonl'), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = rowSchema.parse(JSON.parse(lines[0] ?? ''))
    const second = rowSchema.parse(JSON.parse(lines[1] ?? ''))
    expect(first.type).toBe('session')
    expect(first.id).toBe('ses_1')
    expect(second.type).toBe('message')
    expect(second.role).toBe('user')

    expect(metrics).toEqual({
      sessions_pulled: 1,
      messages_pulled: 1,
      parts_pulled: 0,
      bytes: Buffer.byteLength(content),
    })
  })
})

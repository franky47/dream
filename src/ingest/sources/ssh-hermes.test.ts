import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildRemoteCmd,
  buildRemoteMemoryCmd,
  buildSshBase,
  ingestSshHermes,
  runSshHermesMemoryPipeline,
  runSshHermesPipeline,
} from '#src/ingest/sources/ssh-hermes'

let workDir: string
let dataDir: string

const DAY1_MS = Date.UTC(2026, 4, 9, 12, 0, 0)
const DAY2_MS = Date.UTC(2026, 4, 10, 8, 0, 0)
const DAY1 = '2026-05-09'
const DAY2 = '2026-05-10'

function bucket(day: string): string {
  return path.join(dataDir, day, 'echo', 'hermes')
}

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const next = path.join(d, entry.name)
      const nextRel = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) walk(next, nextRel)
      else out.push(nextRel)
    }
  }
  walk(dir, '')
  return out.sort()
}

beforeEach(() => {
  workDir = path.join(
    tmpdir(),
    `dream-ssh-hermes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  dataDir = path.join(workDir, 'data')
  mkdirSync(dataDir, { recursive: true })
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('ingestSshHermes', () => {
  test('uses host as both ssh target and machine label', () => {
    const src = ingestSshHermes({ host: 'echo' })
    expect(src.machine).toBe('echo')
    expect(src.source).toBe('hermes')
  })
})

describe('buildSshBase', () => {
  test('terminates ssh option parsing with -- right before the host', () => {
    expect(buildSshBase('echo')).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '--',
      'echo',
    ])
  })
})

describe('buildRemoteCmd', () => {
  test('invokes sqlite3 -readonly against the default hermes state db path', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 1_700_000_000_000,
      untilMs: 1_800_000_000_000,
    })
    expect(cmd).toContain('sqlite3 -readonly')
    expect(cmd).toContain('.hermes/state.db')
  })

  test('leaves the default $HOME db path unquoted so the remote shell expands it', () => {
    const cmd = buildRemoteCmd({ sinceMs: 0, untilMs: 1_800_000_000_000 })
    expect(cmd).toContain('sqlite3 -readonly $HOME/.hermes/state.db ')
    expect(cmd).not.toContain(`'$HOME/.hermes/state.db'`)
  })

  test('inlines sinceMs and untilMs literals into the embedded SQL', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 1_700_000_000_000,
      untilMs: 1_800_000_000_000,
    })
    expect(cmd).toContain('1700000000000')
    expect(cmd).toContain('1800000000000')
  })

  test('honours a custom dbPath', () => {
    const cmd = buildRemoteCmd({
      sinceMs: 0,
      untilMs: 1_800_000_000_000,
      dbPath: '/var/lib/hermes/state.db',
    })
    expect(cmd).toContain('/var/lib/hermes/state.db')
  })

  test('shell-quotes the SQL so embedded single quotes survive the remote shell', () => {
    const cmd = buildRemoteCmd({ sinceMs: 0, untilMs: 1_800_000_000_000 })
    expect(cmd).toContain(`'\\''`)
  })
})

describe('runSshHermesPipeline', () => {
  function sessionLine(id: string, latestMessageTime: number): string {
    return JSON.stringify({
      type: 'session',
      id,
      sessionId: id,
      source: 'discord',
      title: id,
      createdAt: latestMessageTime,
      latestMessageTime,
    })
  }

  function messageLine(id: string, sessionId: string, ts: number): string {
    return JSON.stringify({
      type: 'message',
      id,
      sessionId,
      turn: 1,
      role: 'user',
      content: 'hi',
      createdAt: ts,
    })
  }

  test('splits a jsonl stdout stream into per-day session files with md siblings', async () => {
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    const content =
      [
        sessionLine('ses_a', DAY1_MS),
        messageLine('msg_a', 'ses_a', DAY1_MS),
        sessionLine('ses_b', DAY2_MS),
        messageLine('msg_b', 'ses_b', DAY2_MS),
      ].join('\n') + '\n'
    writeFileSync(fixturePath, content)

    const result = await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/ses_a.jsonl`,
      `${DAY1}/echo/hermes/ses_a.md`,
      `${DAY2}/echo/hermes/ses_b.jsonl`,
      `${DAY2}/echo/hermes/ses_b.md`,
    ])
    expect(result.sessions_pulled).toBe(2)
    expect(result.messages_pulled).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(
      readFileSync(path.join(bucket(DAY1), 'ses_a.md'), 'utf-8'),
    ).toContain('sessionId: ses_a')
  })

  test('renders a compacted session as numbered context-window fragments', async () => {
    const summary =
      '[CONTEXT COMPACTION — REFERENCE ONLY] handoff, avoid repeating it:\n' +
      'We planned the refactor.\n' +
      '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_c', DAY1_MS),
        messageLine('m1', 'ses_c', DAY1_MS),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          sessionId: 'ses_c',
          role: 'user',
          content: summary,
          active: 1,
          createdAt: DAY1_MS + 1_000,
        }),
        messageLine('m3', 'ses_c', DAY1_MS + 2_000),
      ].join('\n') + '\n',
    )

    await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/ses_c.1.md`,
      `${DAY1}/echo/hermes/ses_c.2.md`,
      `${DAY1}/echo/hermes/ses_c.jsonl`,
    ])
    const two = readFileSync(path.join(bucket(DAY1), 'ses_c.2.md'), 'utf-8')
    expect(two).toContain('<compaction')
    expect(two).toContain('We planned the refactor.')
    expect(two).not.toContain('avoid repeating it')
  })

  test('joins a rotated chain into one root file with numbered fragments', async () => {
    const summary =
      '[CONTEXT COMPACTION — REFERENCE ONLY] handoff, avoid repeating it:\n' +
      'We planned the refactor.\n' +
      '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
    const chained = (
      obj: Record<string, unknown>,
    ): Record<string, unknown> => ({ ...obj, logicalId: 'ses_root' })
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        JSON.stringify(chained(JSON.parse(sessionLine('ses_root', DAY1_MS)))),
        JSON.stringify(
          chained(JSON.parse(messageLine('m1', 'ses_root', DAY1_MS))),
        ),
        JSON.stringify(
          chained({
            type: 'session',
            id: 'ses_cont',
            sessionId: 'ses_cont',
            source: 'discord',
            title: 'ses_cont',
            parentId: 'ses_root',
            createdAt: DAY1_MS + 1_000,
            latestMessageTime: DAY1_MS,
          }),
        ),
        JSON.stringify(
          chained({
            type: 'message',
            id: 'm2',
            sessionId: 'ses_cont',
            turn: 1,
            role: 'assistant',
            content: summary,
            createdAt: DAY1_MS + 1_000,
          }),
        ),
        JSON.stringify(
          chained(JSON.parse(messageLine('m3', 'ses_cont', DAY1_MS + 2_000))),
        ),
      ].join('\n') + '\n',
    )

    const result = await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    // One logical session: a single root-named jsonl plus two numbered
    // fragments named for the root uuid, no per-physical files.
    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/ses_root.1.md`,
      `${DAY1}/echo/hermes/ses_root.2.md`,
      `${DAY1}/echo/hermes/ses_root.jsonl`,
    ])
    expect(result.sessions_pulled).toBe(1)

    // Raw JSONL retains every physical session id in chain order.
    const raw = readFileSync(path.join(bucket(DAY1), 'ses_root.jsonl'), 'utf-8')
    expect(raw).toContain('"id":"ses_root"')
    expect(raw).toContain('"id":"ses_cont"')

    const two = readFileSync(path.join(bucket(DAY1), 'ses_root.2.md'), 'utf-8')
    expect(two).toContain('<compaction')
    expect(two).toContain('We planned the refactor.')
  })

  test('leaves snapshots in unrelated day buckets untouched', async () => {
    const priorDir = path.join(dataDir, '2026-05-01', 'echo', 'hermes')
    mkdirSync(priorDir, { recursive: true })
    const priorFile = path.join(priorDir, 'ses_old.jsonl')
    writeFileSync(priorFile, 'kept\n')

    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_a', DAY1_MS),
        messageLine('msg_a', 'ses_a', DAY1_MS),
      ].join('\n') + '\n',
    )

    await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(readFileSync(priorFile, 'utf-8')).toBe('kept\n')
  })

  test('removes a stale unnumbered md when a session later compacts', async () => {
    const summary =
      '[CONTEXT COMPACTION — REFERENCE ONLY] handoff, avoid repeating it:\n' +
      'We planned the refactor.\n' +
      '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---'
    const dir = bucket(DAY1)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'ses_c.md'), 'stale unnumbered render\n')

    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_c', DAY1_MS),
        messageLine('m1', 'ses_c', DAY1_MS),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          sessionId: 'ses_c',
          role: 'user',
          content: summary,
          active: 1,
          createdAt: DAY1_MS + 1_000,
        }),
        messageLine('m3', 'ses_c', DAY1_MS + 2_000),
      ].join('\n') + '\n',
    )

    await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/ses_c.1.md`,
      `${DAY1}/echo/hermes/ses_c.2.md`,
      `${DAY1}/echo/hermes/ses_c.jsonl`,
    ])
  })

  test('removes higher-numbered leftovers when the window count shrinks', async () => {
    const dir = bucket(DAY1)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'ses_a.1.md'), 'old fragment 1\n')
    writeFileSync(path.join(dir, 'ses_a.2.md'), 'old fragment 2\n')
    writeFileSync(path.join(dir, 'ses_a.3.md'), 'old fragment 3\n')

    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_a', DAY1_MS),
        messageLine('msg_a', 'ses_a', DAY1_MS),
      ].join('\n') + '\n',
    )

    await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    })

    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/ses_a.jsonl`,
      `${DAY1}/echo/hermes/ses_a.md`,
    ])
  })

  test('handles an empty stdout (no recent sessions) as success', async () => {
    const result = await runSshHermesPipeline({
      upstream: ['sh', '-c', 'true'],
      dataDir,
      host: 'echo',
    })
    expect(result).toEqual({
      sessions_pulled: 0,
      messages_pulled: 0,
      bytes: 0,
    })
  })

  test('throws SshSourceFailure when upstream exits non-zero', async () => {
    const result = await runSshHermesPipeline({
      upstream: ['sh', '-c', 'echo "ssh: Could not resolve" >&2; exit 255'],
      dataDir,
      host: 'invalid.example',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('host=invalid.example')
    expect(result.message).toContain('ssh=255')
    expect(result.message).toContain('Could not resolve')
  })

  test('writes no final files when the transport exits non-zero mid-stream', async () => {
    // A full, valid session streams out, then the transport dies. The staged
    // rows never reach disk because commit is gated on a clean exit.
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_a', DAY1_MS),
        messageLine('msg_a', 'ses_a', DAY1_MS),
      ].join('\n') + '\n',
    )

    const result = await runSshHermesPipeline({
      upstream: ['sh', '-c', `cat ${fixturePath}; exit 3`],
      dataDir,
      host: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    expect(listFiles(dataDir)).toEqual([])
  })

  test('writes no final files when a late row is malformed', async () => {
    const fixturePath = path.join(workDir, 'fixture.jsonl')
    writeFileSync(
      fixturePath,
      [
        sessionLine('ses_a', DAY1_MS),
        messageLine('msg_a', 'ses_a', DAY1_MS),
        '{"type":"message","id":"m2","sessionId":"ses_a","role":"user","content":"hi","createdAt":null}',
      ].join('\n') + '\n',
    )

    const result = await runSshHermesPipeline({
      upstream: ['cat', fixturePath],
      dataDir,
      host: 'echo',
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    expect(listFiles(dataDir)).toEqual([])
  })
})

describe('buildRemoteMemoryCmd', () => {
  test('discovers only MEMORY.md and USER.md from the default hermes memories dir', () => {
    const cmd = buildRemoteMemoryCmd({ sinceMs: DAY1_MS })
    expect(cmd).toContain('cd $HOME/.hermes/memories && ')
    expect(cmd).toContain(`-name 'MEMORY.md'`)
    expect(cmd).toContain(`-name 'USER.md'`)
  })

  test('caps the search at the memory dir so provider subdirs stay out', () => {
    const cmd = buildRemoteMemoryCmd({ sinceMs: DAY1_MS })
    expect(cmd).toContain('-maxdepth 1')
  })

  test('streams the matches through tar to preserve mtime', () => {
    const cmd = buildRemoteMemoryCmd({ sinceMs: DAY1_MS })
    expect(cmd).toContain('tar --null --no-recursion -czf - -T -')
  })

  test('anchors the archive so an empty match does not fail tar', () => {
    const cmd = buildRemoteMemoryCmd({ sinceMs: DAY1_MS })
    expect(cmd).toContain(`{ printf '.\\0';`)
    expect(cmd).toContain('--no-recursion')
  })

  test('backs the strictly-newer bound off one second below the since instant', () => {
    // `find -newermt` is strictly-newer, so the bound sits one second below
    // `since`; a file whose mtime equals the whole-second `since` instant then
    // survives the remote pass and the inclusive local filter decides.
    const cmd = buildRemoteMemoryCmd({ sinceMs: DAY1_MS })
    expect(cmd).toContain(`-newermt '2026-05-09 11:59:59 UTC'`)
  })

  test('leaves the default $HOME memory dir unquoted so the shell expands it', () => {
    const cmd = buildRemoteMemoryCmd({ sinceMs: 0 })
    expect(cmd).toContain('cd $HOME/.hermes/memories && ')
    expect(cmd).not.toContain(`'$HOME/.hermes/memories'`)
  })

  test('shell-quotes a custom memory dir', () => {
    const cmd = buildRemoteMemoryCmd({
      sinceMs: 0,
      memoryDir: '/var/lib/hermes',
    })
    expect(cmd).toContain(`cd '/var/lib/hermes' && `)
  })

  test('guards on the directory and falls back to an empty anchored archive', () => {
    const cmd = buildRemoteMemoryCmd({ sinceMs: DAY1_MS })
    expect(cmd).toContain('if [ -d $HOME/.hermes/memories ]; then ')
    expect(cmd).toContain(
      `else printf '.\\0' | tar --null --no-recursion -czf - -T -; fi`,
    )
  })

  test('propagates a find failure by routing its output through a temp file', () => {
    // `find ... | tar` reports only tar's status, so find output lands in a temp
    // file behind `&&`; a find error short-circuits the chain before tar runs.
    const cmd = buildRemoteMemoryCmd({ sinceMs: DAY1_MS })
    expect(cmd).toContain(`-print0 > "$list" && `)
    expect(cmd).toContain('status=$?; rm -f "$list"; exit $status')
  })
})

describe('runSshHermesMemoryPipeline', () => {
  const SINCE = new Date(Date.UTC(2026, 4, 9, 0, 0, 0))
  const UNTIL = new Date(Date.UTC(2026, 4, 11, 0, 0, 0))

  function memBucket(day: string): string {
    return path.join(dataDir, day, 'echo', 'hermes', 'memories')
  }

  function writeMemoryFixture(
    files: ReadonlyArray<{ name: string; content: string; mtimeMs: number }>,
  ): string {
    const dir = path.join(
      workDir,
      `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(dir, { recursive: true })
    for (const file of files) {
      const abs = path.join(dir, file.name)
      writeFileSync(abs, file.content)
      const seconds = file.mtimeMs / 1000
      utimesSync(abs, seconds, seconds)
    }
    return dir
  }

  function tarUpstream(dir: string, names: ReadonlyArray<string>): string[] {
    return ['tar', '-czf', '-', '-C', dir, ...names]
  }

  test('copies both files byte-for-byte into their own UTC day buckets', async () => {
    const dir = writeMemoryFixture([
      { name: 'MEMORY.md', content: '# agent memory\n', mtimeMs: DAY1_MS },
      { name: 'USER.md', content: '# user profile\n', mtimeMs: DAY2_MS },
    ])

    const result = await runSshHermesMemoryPipeline({
      upstream: tarUpstream(dir, ['MEMORY.md', 'USER.md']),
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result.memories_pulled).toBe(2)
    expect(result.bytes).toBe(
      Buffer.byteLength('# agent memory\n') +
        Buffer.byteLength('# user profile\n'),
    )
    expect(readFileSync(path.join(memBucket(DAY1), 'MEMORY.md'), 'utf-8')).toBe(
      '# agent memory\n',
    )
    expect(readFileSync(path.join(memBucket(DAY2), 'USER.md'), 'utf-8')).toBe(
      '# user profile\n',
    )
    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/memories/MEMORY.md`,
      `${DAY2}/echo/hermes/memories/USER.md`,
    ])
  })

  test('generates no sibling renderer output for memory markdown', async () => {
    const dir = writeMemoryFixture([
      { name: 'MEMORY.md', content: '# agent memory\n', mtimeMs: DAY1_MS },
    ])

    await runSshHermesMemoryPipeline({
      upstream: tarUpstream(dir, ['MEMORY.md']),
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(readdirSync(memBucket(DAY1)).sort()).toEqual(['MEMORY.md'])
  })

  test('treats a missing memory file as harmless', async () => {
    const dir = writeMemoryFixture([
      { name: 'MEMORY.md', content: 'only me\n', mtimeMs: DAY1_MS },
    ])

    const result = await runSshHermesMemoryPipeline({
      upstream: tarUpstream(dir, ['MEMORY.md']),
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result.memories_pulled).toBe(1)
    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/memories/MEMORY.md`,
    ])
  })

  test('reports zero when no memory files are present', async () => {
    const dir = writeMemoryFixture([])

    const result = await runSshHermesMemoryPipeline({
      upstream: tarUpstream(dir, ['.']),
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result).toEqual({ memories_pulled: 0, bytes: 0 })
  })

  test('treats the anchor-only archive of an empty match as zero memories', async () => {
    const emptyDir = writeMemoryFixture([])
    const result = await runSshHermesMemoryPipeline({
      upstream: [
        'sh',
        '-c',
        `cd ${emptyDir} && printf '.\\0' | tar --null --no-recursion -czf - -T -`,
      ],
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result).toEqual({ memories_pulled: 0, bytes: 0 })
  })

  test('a missing memories dir yields zero, not a transport failure', async () => {
    const missingDir = path.join(workDir, 'no-such-hermes-memories')
    const cmd = buildRemoteMemoryCmd({
      sinceMs: SINCE.getTime(),
      memoryDir: missingDir,
    })

    const result = await runSshHermesMemoryPipeline({
      upstream: ['sh', '-c', cmd],
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result).toEqual({ memories_pulled: 0, bytes: 0 })
    expect(listFiles(dataDir)).toEqual([])
  })

  test('keeps a file whose mtime sits exactly on the inclusive since instant', async () => {
    const dir = writeMemoryFixture([
      {
        name: 'MEMORY.md',
        content: 'right on since\n',
        mtimeMs: SINCE.getTime(),
      },
    ])

    const result = await runSshHermesMemoryPipeline({
      upstream: tarUpstream(dir, ['MEMORY.md']),
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result.memories_pulled).toBe(1)
  })

  test('excludes files modified outside the half-open window', async () => {
    const beforeSince = Date.UTC(2026, 4, 8, 12, 0, 0)
    const atUntil = UNTIL.getTime()
    const dir = writeMemoryFixture([
      { name: 'MEMORY.md', content: 'too old\n', mtimeMs: beforeSince },
      { name: 'USER.md', content: 'too new\n', mtimeMs: atUntil },
    ])

    const result = await runSshHermesMemoryPipeline({
      upstream: tarUpstream(dir, ['MEMORY.md', 'USER.md']),
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result).toEqual({ memories_pulled: 0, bytes: 0 })
  })

  test('ignores lock files and other memory-directory entries', async () => {
    const dir = writeMemoryFixture([
      { name: 'MEMORY.md', content: 'kept\n', mtimeMs: DAY1_MS },
      { name: 'MEMORY.md.lock', content: '', mtimeMs: DAY1_MS },
      { name: 'notes.txt', content: 'skip me\n', mtimeMs: DAY1_MS },
    ])

    const result = await runSshHermesMemoryPipeline({
      upstream: tarUpstream(dir, ['.']),
      dataDir,
      host: 'echo',
      since: SINCE,
      until: UNTIL,
    })

    expect(result.memories_pulled).toBe(1)
    expect(listFiles(dataDir)).toEqual([
      `${DAY1}/echo/hermes/memories/MEMORY.md`,
    ])
  })

  test('throws when the upstream transport fails', async () => {
    const result = await runSshHermesMemoryPipeline({
      upstream: ['sh', '-c', 'echo "ssh: Could not resolve" >&2; exit 255'],
      dataDir,
      host: 'invalid.example',
      since: SINCE,
      until: UNTIL,
    }).catch((e: unknown) => e)

    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('unreachable')
    expect(result.message).toContain('host=invalid.example')
    expect(result.message).toContain('ssh=255')
  })
})

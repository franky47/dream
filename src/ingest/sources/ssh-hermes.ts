import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Glob } from 'bun'
import * as errore from 'errore'

import { buildProjectionSql, splitJsonlToSessionFiles } from '#lib/hermes/pull'
import { renderHermesFragments } from '#lib/hermes/renderer'
import { utcDay } from '#lib/utc-day'
import type { Source } from '#src/ingest/orchestrator'

const SOURCE = 'hermes'
// `$HOME` (not `~`): the whole command is single-quoted for the remote shell,
// where a leading `~` would stay literal but `$HOME` still expands to the
// operator's home directory.
const DEFAULT_REMOTE_DB_PATH = '$HOME/.hermes/state.db'
const DEFAULT_REMOTE_MEMORY_DIR = '$HOME/.hermes/memories'

// Hermes keeps exactly two built-in memory files. Every other entry in the
// memory directory (lock files, the state db, optional provider data) stays
// out of the copy.
const MEMORY_FILES: ReadonlySet<string> = new Set(['MEMORY.md', 'USER.md'])

class SshSourceFailure extends errore.createTaggedError({
  name: 'SshSourceFailure',
  message:
    'ssh+sqlite3 failed for $machine/$source (host=$host, ssh=$sshExit): $stderr',
}) {}

function shellSingleQuote(s: string): string {
  return `'${s.replaceAll(`'`, `'\\''`)}'`
}

function quoteRemotePath(remotePath: string, defaultLiteral: string): string {
  // The default references `$HOME`, which must reach the remote shell
  // unquoted to expand. A caller-supplied path is shell-quoted literally.
  if (remotePath === defaultLiteral) return remotePath
  return shellSingleQuote(remotePath)
}

function formatSinceForFind(d: Date): string {
  const iso = d.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

// Remote `find -newermt` is strictly-newer and only resolves whole seconds,
// but the window contract is inclusive at `since`. Back the remote bound off by
// one second so a memory file whose mtime lands exactly on the whole-second
// `since` instant still reaches the tar stream; the authoritative local
// `mtimeMs >= sinceMs` filter then decides what to keep.
const FIND_OVER_INCLUSIVE_MS = 1000

export function buildRemoteCmd(opts: {
  sinceMs: number
  untilMs: number
  dbPath?: string
}): string {
  const dbPath = opts.dbPath ?? DEFAULT_REMOTE_DB_PATH
  const sql = buildProjectionSql({
    sinceMs: opts.sinceMs,
    untilMs: opts.untilMs,
  })
  const quotedDbPath = quoteRemotePath(dbPath, DEFAULT_REMOTE_DB_PATH)
  return `sqlite3 -readonly ${quotedDbPath} ${shellSingleQuote(sql)}`
}

// Only the two built-in memory files reach the tar stream: `-maxdepth 1` keeps
// the search shallow so optional provider subdirectories stay untouched, and
// `-newermt` bounds it below by the ingest window's since instant. `tar`
// preserves each file's mtime so the pipeline can route by modification time.
//
// The leading `.` anchor plus `--no-recursion` keeps tar from the "cowardly
// refusing to create an empty archive" failure when no memory file changed in
// the window: the memory directory is archived as a bare directory entry (never
// its contents, so the state db stays out) that the extraction side ignores.
export function buildRemoteMemoryCmd(opts: {
  sinceMs: number
  memoryDir?: string
}): string {
  const memoryDir = opts.memoryDir ?? DEFAULT_REMOTE_MEMORY_DIR
  const quotedDir = quoteRemotePath(memoryDir, DEFAULT_REMOTE_MEMORY_DIR)
  const sinceStr = formatSinceForFind(
    new Date(opts.sinceMs - FIND_OVER_INCLUSIVE_MS),
  )
  return (
    `cd ${quotedDir} && ` +
    `{ printf '.\\0'; ` +
    `find . -maxdepth 1 ` +
    `\\( -name 'MEMORY.md' -o -name 'USER.md' \\) ` +
    `-newermt '${sinceStr}' -print0; } ` +
    `| tar --null --no-recursion -czf - -T -`
  )
}

async function readAll(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return ''
  return new Response(stream).text()
}

async function* streamToLines(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx = buf.indexOf('\n')
      while (idx !== -1) {
        yield buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        idx = buf.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  buf += decoder.decode()
  if (buf.length > 0) yield buf
}

export async function runSshHermesPipeline(opts: {
  upstream: string[]
  dataDir: string
  host: string
}): Promise<{
  sessions_pulled: number
  messages_pulled: number
  bytes: number
}> {
  const proc = Bun.spawn(opts.upstream, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  const stdout = proc.stdout
  if (stdout === null) {
    throw new SshSourceFailure({
      machine: opts.host,
      source: SOURCE,
      host: opts.host,
      sshExit: -1,
      stderr: 'stdout pipe missing',
    })
  }

  const splitterPromise = splitJsonlToSessionFiles({
    lines: streamToLines(stdout),
    dataDir: opts.dataDir,
    machine: opts.host,
  })

  const [splitResult, sshExit, sshStderr] = await Promise.all([
    splitterPromise,
    proc.exited,
    readAll(proc.stderr),
  ])

  if (sshExit !== 0) {
    const stderr = sshStderr.trim().slice(0, 500) || '(no stderr captured)'
    throw new SshSourceFailure({
      machine: opts.host,
      source: SOURCE,
      host: opts.host,
      sshExit,
      stderr,
    })
  }

  // The stream drained and SSH exited clean, so the staged sessions are whole;
  // only now do the final `.jsonl` files land on disk. A dropped transport
  // leaves the staging in memory untouched and nothing partial behind.
  const { sessionPaths, commit, ...metrics } = splitResult
  await commit()
  for (const jsonlPath of sessionPaths) {
    const jsonlText = await Bun.file(jsonlPath).text()
    const base = jsonlPath.replace(/\.jsonl$/, '')
    for (const fragment of renderHermesFragments(jsonlText)) {
      const suffix =
        fragment.contextWindow === null ? '' : `.${fragment.contextWindow}`
      await Bun.write(`${base}${suffix}.md`, fragment.markdown)
    }
  }

  return metrics
}

class SshMemoryFailure extends errore.createTaggedError({
  name: 'SshMemoryFailure',
  message:
    'ssh+tar (memory) failed for $machine/$source (host=$host, ssh=$sshExit, tar=$tarExit): $stderr',
}) {}

// Extracts the ssh+tar stream into a temp dir, then keeps only the two built-in
// memory files whose mtime falls inside the half-open [since, until) window and
// copies each byte-for-byte into its modification day's `memories` bucket. This
// mirrors the session projection's window bound and Codex's memory routing. The
// remote `find` can only express the lower bound, so the strict `< until` upper
// bound is enforced here.
export async function runSshHermesMemoryPipeline(opts: {
  upstream: string[]
  dataDir: string
  host: string
  since: Date
  until: Date
}): Promise<{ memories_pulled: number; bytes: number }> {
  const stageDir = await mkdtemp(path.join(tmpdir(), 'dream-ssh-hermes-mem-'))
  try {
    const ssh = Bun.spawn(opts.upstream, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const tar = Bun.spawn(['tar', '-xzf', '-', '-C', stageDir], {
      stdin: ssh.stdout,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [sshExit, tarExit, sshStderr, tarStderr] = await Promise.all([
      ssh.exited,
      tar.exited,
      readAll(ssh.stderr),
      readAll(tar.stderr),
    ])

    if (sshExit !== 0 || tarExit !== 0) {
      const stderr = [sshStderr, tarStderr]
        .filter((s) => s.trim().length > 0)
        .join(' | ')
        .slice(0, 500)
        .trim()
      throw new SshMemoryFailure({
        machine: opts.host,
        source: SOURCE,
        host: opts.host,
        sshExit,
        tarExit,
        stderr: stderr || '(no stderr captured)',
      })
    }

    const sinceMs = opts.since.getTime()
    const untilMs = opts.until.getTime()
    const glob = new Glob('**/*')
    let memoriesPulled = 0
    let bytes = 0
    for await (const rel of glob.scan({ cwd: stageDir, onlyFiles: true })) {
      const name = path.basename(rel)
      if (!MEMORY_FILES.has(name)) continue
      const abs = path.join(stageDir, rel)
      const info = await stat(abs)
      if (info.mtimeMs < sinceMs || info.mtimeMs >= untilMs) continue
      const dst = path.join(
        opts.dataDir,
        utcDay(new Date(info.mtimeMs)),
        opts.host,
        SOURCE,
        'memories',
        name,
      )
      await mkdir(path.dirname(dst), { recursive: true })
      bytes += await Bun.write(dst, Bun.file(abs))
      memoriesPulled += 1
    }
    return { memories_pulled: memoriesPulled, bytes }
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

export function ingestSshHermes(opts: { host: string }): Source {
  return {
    machine: opts.host,
    source: SOURCE,
    pull: async ({ dataDir, since, until }) => {
      const sshBase = ['ssh', '-o', 'BatchMode=yes', opts.host]
      const [sessions, memories] = await Promise.all([
        runSshHermesPipeline({
          upstream: [
            ...sshBase,
            buildRemoteCmd({
              sinceMs: since.getTime(),
              untilMs: until.getTime(),
            }),
          ],
          dataDir,
          host: opts.host,
        }),
        runSshHermesMemoryPipeline({
          upstream: [
            ...sshBase,
            buildRemoteMemoryCmd({ sinceMs: since.getTime() }),
          ],
          dataDir,
          host: opts.host,
          since,
          until,
        }),
      ])
      return {
        sessions_pulled: sessions.sessions_pulled,
        messages_pulled: sessions.messages_pulled,
        memories_pulled: memories.memories_pulled,
        bytes: sessions.bytes + memories.bytes,
      }
    },
  }
}

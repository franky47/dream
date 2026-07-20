import * as errore from 'errore'

import { buildProjectionSql, splitJsonlToSessionFiles } from '#lib/hermes/pull'
import { renderHermesSession } from '#lib/hermes/renderer'
import type { Source } from '#src/ingest/orchestrator'

const SOURCE = 'hermes'
// `$HOME` (not `~`): the whole command is single-quoted for the remote shell,
// where a leading `~` would stay literal but `$HOME` still expands to the
// operator's home directory.
const DEFAULT_REMOTE_DB_PATH = '$HOME/.hermes/state.db'

class SshSourceFailure extends errore.createTaggedError({
  name: 'SshSourceFailure',
  message:
    'ssh+sqlite3 failed for $machine/$source (host=$host, ssh=$sshExit): $stderr',
}) {}

function shellSingleQuote(s: string): string {
  return `'${s.replaceAll(`'`, `'\\''`)}'`
}

function quoteDbPath(dbPath: string): string {
  // The default references `$HOME`, which must reach the remote shell
  // unquoted to expand. A caller-supplied path is shell-quoted literally.
  if (dbPath === DEFAULT_REMOTE_DB_PATH) return dbPath
  return shellSingleQuote(dbPath)
}

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
  return `sqlite3 -readonly ${quoteDbPath(dbPath)} ${shellSingleQuote(sql)}`
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

  const { sessionPaths, ...metrics } = splitResult
  for (const jsonlPath of sessionPaths) {
    const jsonlText = await Bun.file(jsonlPath).text()
    const md = renderHermesSession(jsonlText)
    await Bun.write(jsonlPath.replace(/\.jsonl$/, '.md'), md)
  }

  return metrics
}

export function ingestSshHermes(opts: { host: string }): Source {
  return {
    machine: opts.host,
    source: SOURCE,
    pull: async ({ dataDir, since, until }) =>
      runSshHermesPipeline({
        upstream: [
          'ssh',
          '-o',
          'BatchMode=yes',
          opts.host,
          buildRemoteCmd({
            sinceMs: since.getTime(),
            untilMs: until.getTime(),
          }),
        ],
        dataDir,
        host: opts.host,
      }),
  }
}

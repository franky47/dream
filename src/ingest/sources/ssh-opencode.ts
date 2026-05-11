import * as errore from 'errore'

import { buildProjectionSql, splitJsonlToSessionFiles } from '#lib/opencode'
import type { Source } from '#src/ingest/orchestrator'

const SOURCE = 'opencode'
const DEFAULT_REMOTE_DB_PATH = '~/.local/share/opencode/opencode.db'

class SshSourceFailure extends errore.createTaggedError({
  name: 'SshSourceFailure',
  message:
    'ssh+sqlite3 failed for $machine/$source (host=$host, ssh=$sshExit): $stderr',
}) {}

function shellSingleQuote(s: string): string {
  return `'${s.replaceAll(`'`, `'\\''`)}'`
}

export function buildRemoteCmd(opts: {
  sinceMs: number
  dbPath?: string
}): string {
  const dbPath = opts.dbPath ?? DEFAULT_REMOTE_DB_PATH
  const sql = buildProjectionSql({ sinceMs: opts.sinceMs })
  return `sqlite3 -readonly ${shellSingleQuote(dbPath)} ${shellSingleQuote(sql)}`
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

export async function runSshOpencodePipeline(opts: {
  upstream: string[]
  outDir: string
  host: string
}): Promise<{
  sessions_pulled: number
  messages_pulled: number
  parts_pulled: number
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
    outDir: opts.outDir,
  })

  const [metrics, sshExit, sshStderr] = await Promise.all([
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

  return metrics
}

export function ingestSshOpencode(opts: { host: string }): Source {
  return {
    machine: opts.host,
    source: SOURCE,
    pull: async ({ outDir, since }) =>
      runSshOpencodePipeline({
        upstream: [
          'ssh',
          '-o',
          'BatchMode=yes',
          opts.host,
          buildRemoteCmd({ sinceMs: since.getTime() }),
        ],
        outDir,
        host: opts.host,
      }),
  }
}

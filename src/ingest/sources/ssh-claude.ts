import { stat } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'
import * as errore from 'errore'

import { renderClaudeSession } from '#lib/claude/renderer'
import type { Source } from '#src/ingest/orchestrator'

const SOURCE = 'claude'

class SshSourceFailure extends errore.createTaggedError({
  name: 'SshSourceFailure',
  message:
    'ssh+tar failed for $machine/$source (host=$host, ssh=$sshExit, tar=$tarExit): $stderr',
}) {}

function formatSinceForFind(d: Date): string {
  const iso = d.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

export function buildRemoteCmd(since: Date): string {
  const sinceStr = formatSinceForFind(since)
  return (
    `cd ~/.claude && find projects ` +
    `\\( ` +
    `\\( -name '*.jsonl' -not -path '*/subagents/*' \\) ` +
    `-o -path '*/memory/*.md' ` +
    `\\) ` +
    `-newermt '${sinceStr}' -print0 ` +
    `| tar --null -czf - -T -`
  )
}

async function readAll(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return ''
  return new Response(stream).text()
}

export async function runSshTarPipeline(opts: {
  upstream: string[]
  outDir: string
  host: string
}): Promise<{
  sessions_pulled: number
  memories_pulled: number
  bytes: number
}> {
  const ssh = Bun.spawn(opts.upstream, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const tar = Bun.spawn(['tar', '-xzf', '-', '-C', opts.outDir], {
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
    throw new SshSourceFailure({
      machine: opts.host,
      source: SOURCE,
      host: opts.host,
      sshExit,
      tarExit,
      stderr: stderr || '(no stderr captured)',
    })
  }

  const glob = new Glob('**/*')
  let sessionsPulled = 0
  let memoriesPulled = 0
  let bytes = 0
  const jsonlPaths: string[] = []
  for await (const rel of glob.scan({ cwd: opts.outDir, onlyFiles: true })) {
    const abs = path.join(opts.outDir, rel)
    const info = await stat(abs)
    bytes += info.size
    if (rel.endsWith('.jsonl')) {
      sessionsPulled += 1
      jsonlPaths.push(abs)
    } else if (rel.endsWith('.md')) {
      memoriesPulled += 1
    }
  }
  for (const abs of jsonlPaths) {
    const jsonlText = await Bun.file(abs).text()
    const md = renderClaudeSession(jsonlText)
    await Bun.write(abs.replace(/\.jsonl$/, '.md'), md)
  }
  return {
    sessions_pulled: sessionsPulled,
    memories_pulled: memoriesPulled,
    bytes,
  }
}

export function ingestSshClaude(opts: { host: string }): Source {
  return {
    machine: opts.host,
    source: SOURCE,
    pull: async ({ outDir, since }) =>
      // BatchMode=yes ensures ssh fails fast on auth prompts instead of
      // hanging in a non-interactive run.
      runSshTarPipeline({
        upstream: [
          'ssh',
          '-o',
          'BatchMode=yes',
          opts.host,
          buildRemoteCmd(since),
        ],
        outDir,
        host: opts.host,
      }),
  }
}

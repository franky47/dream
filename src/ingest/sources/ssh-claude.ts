import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Glob } from 'bun'
import * as errore from 'errore'

import { renderClaudeSession } from '#lib/claude/renderer'
import type { Source } from '#src/ingest/orchestrator'
import { utcDay } from '#src/ingest/utc-day'

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

// Extracts the ssh+tar stream into a temp dir, then post-filters by mtime and
// routes each in-window file into its UTC-day bucket. The remote `find` can
// only express the lower bound (`-newermt`), so the strict `< until` upper
// bound is enforced here in TypeScript before routing.
export async function runSshTarPipeline(opts: {
  upstream: string[]
  dataDir: string
  host: string
  since: Date
  until: Date
}): Promise<{
  sessions_pulled: number
  memories_pulled: number
  bytes: number
}> {
  const stageDir = await mkdtemp(path.join(tmpdir(), 'dream-ssh-claude-'))
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
      throw new SshSourceFailure({
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
    let sessionsPulled = 0
    let memoriesPulled = 0
    let bytes = 0
    const jsonlDsts: string[] = []
    for await (const rel of glob.scan({ cwd: stageDir, onlyFiles: true })) {
      const abs = path.join(stageDir, rel)
      const info = await stat(abs)
      if (info.mtimeMs <= sinceMs || info.mtimeMs >= untilMs) continue
      const dst = path.join(
        opts.dataDir,
        utcDay(new Date(info.mtimeMs)),
        opts.host,
        SOURCE,
        rel,
      )
      await mkdir(path.dirname(dst), { recursive: true })
      bytes += await Bun.write(dst, Bun.file(abs))
      if (rel.endsWith('.jsonl')) {
        sessionsPulled += 1
        jsonlDsts.push(dst)
      } else if (rel.endsWith('.md')) {
        memoriesPulled += 1
      }
    }
    for (const dst of jsonlDsts) {
      const jsonlText = await Bun.file(dst).text()
      const md = renderClaudeSession(jsonlText)
      await Bun.write(dst.replace(/\.jsonl$/, '.md'), md)
    }
    return {
      sessions_pulled: sessionsPulled,
      memories_pulled: memoriesPulled,
      bytes,
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

export function ingestSshClaude(opts: { host: string }): Source {
  return {
    machine: opts.host,
    source: SOURCE,
    pull: async ({ dataDir, since, until }) =>
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
        dataDir,
        host: opts.host,
        since,
        until,
      }),
  }
}

import { stat } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'
import * as errore from 'errore'

import type { Source } from '#src/ingest/orchestrator'

const SOURCE = 'claude-sessions'

class SshSourceFailure extends errore.createTaggedError({
  name: 'SshSourceFailure',
  message:
    'ssh+tar failed for $machine/$source (host=$host, ssh=$sshExit, tar=$tarExit): $stderr',
}) {}

function formatSinceForFind(d: Date): string {
  const iso = d.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

async function readAll(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) return ''
  return new Response(stream).text()
}

export function ingestSshClaudeSessions(opts: {
  machine: string
  host: string
}): Source {
  return {
    machine: opts.machine,
    source: SOURCE,
    pull: async ({ outDir, since }) => {
      const sinceStr = formatSinceForFind(since)
      const remoteCmd =
        `cd ~/.claude && find projects -name '*.jsonl' ` +
        `-newermt '${sinceStr}' -not -path '*/subagents/*' -print0 ` +
        `| tar --null -czf - -T -`

      // BatchMode=yes ensures ssh fails fast on auth prompts instead of
      // hanging in a non-interactive nightly run.
      const ssh = Bun.spawn(
        ['ssh', '-o', 'BatchMode=yes', opts.host, remoteCmd],
        { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
      )
      const tar = Bun.spawn(['tar', '-xzf', '-', '-C', outDir], {
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
          machine: opts.machine,
          source: SOURCE,
          host: opts.host,
          sshExit,
          tarExit,
          stderr: stderr || '(no stderr captured)',
        })
      }

      const glob = new Glob('**/*.jsonl')
      let filesPulled = 0
      let bytes = 0
      for await (const rel of glob.scan({ cwd: outDir, onlyFiles: true })) {
        const info = await stat(path.join(outDir, rel))
        filesPulled += 1
        bytes += info.size
      }
      return { files_pulled: filesPulled, bytes }
    },
  }
}

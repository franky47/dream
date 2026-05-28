import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'

import { renderCodexSession } from '#lib/codex/renderer'
import { utcDay } from '#lib/utc-day'
import type { Source } from '#src/ingest/orchestrator'

export function ingestLocalCodex(opts: {
  machine: string
  sourceDir: string
}): Source {
  return {
    machine: opts.machine,
    source: 'codex',
    pull: async ({ dataDir, since, until }) => {
      const sinceMs = since.getTime()
      const untilMs = until.getTime()
      let sessionsPulled = 0
      let memoriesPulled = 0
      let bytes = 0

      const copyIfFresh = async (
        absSrc: string,
        relDst: string,
      ): Promise<string | null> => {
        const info = await stat(absSrc)
        if (info.mtimeMs <= sinceMs || info.mtimeMs >= untilMs) return null
        const dst = path.join(
          dataDir,
          utcDay(new Date(info.mtimeMs)),
          opts.machine,
          'codex',
          relDst,
        )
        await mkdir(path.dirname(dst), { recursive: true })
        bytes += await Bun.write(dst, Bun.file(absSrc))
        return dst
      }

      const sessionsDir = path.join(opts.sourceDir, 'sessions')
      if (existsSync(sessionsDir)) {
        const sessions = new Glob('**/*.jsonl')
        for await (const rel of sessions.scan({
          cwd: sessionsDir,
          absolute: false,
          onlyFiles: true,
        })) {
          const absSrc = path.join(sessionsDir, rel)
          const dst = await copyIfFresh(absSrc, path.basename(rel))
          if (dst === null) continue
          sessionsPulled += 1
          const jsonlText = await Bun.file(dst).text()
          const md = renderCodexSession(jsonlText)
          await Bun.write(dst.replace(/\.jsonl$/, '.md'), md)
        }
      }

      const memoriesDir = path.join(opts.sourceDir, 'memories')
      if (existsSync(memoriesDir)) {
        const memories = new Glob('**/*.md')
        for await (const rel of memories.scan({
          cwd: memoriesDir,
          absolute: false,
          onlyFiles: true,
        })) {
          const absSrc = path.join(memoriesDir, rel)
          const dst = await copyIfFresh(absSrc, path.join('memories', rel))
          if (dst !== null) memoriesPulled += 1
        }
      }

      return {
        sessions_pulled: sessionsPulled,
        memories_pulled: memoriesPulled,
        bytes,
      }
    },
  }
}

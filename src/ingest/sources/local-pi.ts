import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'

import { renderPiSession } from '#lib/pi/renderer'
import { utcDay } from '#lib/utc-day'
import type { Source } from '#src/ingest/orchestrator'

export function ingestLocalPi(opts: {
  machine: string
  sourceDir: string
}): Source {
  return {
    machine: opts.machine,
    source: 'pi',
    pull: async ({ dataDir, since, until }) => {
      const sinceMs = since.getTime()
      const untilMs = until.getTime()
      let sessionsPulled = 0
      let bytes = 0

      const sessionsDir = path.join(opts.sourceDir, 'sessions')
      if (!existsSync(sessionsDir)) {
        return { sessions_pulled: 0, bytes: 0 }
      }

      const sessions = new Glob('**/*.jsonl')
      for await (const rel of sessions.scan({
        cwd: sessionsDir,
        absolute: false,
        onlyFiles: true,
      })) {
        const absSrc = path.join(sessionsDir, rel)
        const info = await stat(absSrc)
        if (info.mtimeMs <= sinceMs || info.mtimeMs >= untilMs) continue
        const dst = path.join(
          dataDir,
          utcDay(new Date(info.mtimeMs)),
          opts.machine,
          'pi',
          rel,
        )
        await mkdir(path.dirname(dst), { recursive: true })
        bytes += await Bun.write(dst, Bun.file(absSrc))
        sessionsPulled += 1
        const jsonlText = await Bun.file(dst).text()
        const md = renderPiSession(jsonlText)
        await Bun.write(dst.replace(/\.jsonl$/, '.md'), md)
      }

      return { sessions_pulled: sessionsPulled, bytes }
    },
  }
}

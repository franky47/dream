import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'

import { renderClaudeSession } from '#lib/claude/renderer'
import type { Source } from '#src/ingest/orchestrator'
import { utcDay } from '#src/ingest/utc-day'

export function ingestLocalClaude(opts: {
  machine: string
  sourceDir: string
}): Source {
  return {
    machine: opts.machine,
    source: 'claude',
    pull: async ({ dataDir, since, until }) => {
      const sinceMs = since.getTime()
      const untilMs = until.getTime()
      let sessionsPulled = 0
      let memoriesPulled = 0
      let bytes = 0

      // Copies an in-window file into its mtime day-bucket; returns the
      // destination path, or null when the file falls outside [since, until).
      const copyIfFresh = async (rel: string): Promise<string | null> => {
        const src = path.join(opts.sourceDir, rel)
        const info = await stat(src)
        if (info.mtimeMs <= sinceMs || info.mtimeMs >= untilMs) return null
        const dst = path.join(
          dataDir,
          utcDay(new Date(info.mtimeMs)),
          opts.machine,
          'claude',
          rel,
        )
        await mkdir(path.dirname(dst), { recursive: true })
        bytes += await Bun.write(dst, Bun.file(src))
        return dst
      }

      const renderSibling = async (jsonlDst: string): Promise<void> => {
        const jsonlText = await Bun.file(jsonlDst).text()
        const md = renderClaudeSession(jsonlText)
        await Bun.write(jsonlDst.replace(/\.jsonl$/, '.md'), md)
      }

      const sessions = new Glob('**/*.jsonl')
      for await (const rel of sessions.scan({
        cwd: opts.sourceDir,
        absolute: false,
        onlyFiles: true,
      })) {
        if (rel.split(path.sep).includes('subagents')) continue
        const dst = await copyIfFresh(rel)
        if (dst !== null) {
          sessionsPulled += 1
          await renderSibling(dst)
        }
      }

      const memories = new Glob('*/memory/*.md')
      for await (const rel of memories.scan({
        cwd: opts.sourceDir,
        absolute: false,
        onlyFiles: true,
      })) {
        if ((await copyIfFresh(rel)) !== null) memoriesPulled += 1
      }

      return {
        sessions_pulled: sessionsPulled,
        memories_pulled: memoriesPulled,
        bytes,
      }
    },
  }
}

import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'

import { renderClaudeSession } from '#lib/claude/renderer'
import type { Source } from '#src/ingest/orchestrator'

export function ingestLocalClaude(opts: {
  machine: string
  sourceDir: string
}): Source {
  return {
    machine: opts.machine,
    source: 'claude',
    pull: async ({ outDir, since }) => {
      const sinceMs = since.getTime()
      let sessionsPulled = 0
      let memoriesPulled = 0
      let bytes = 0

      const copyIfFresh = async (rel: string): Promise<boolean> => {
        const src = path.join(opts.sourceDir, rel)
        const info = await stat(src)
        if (info.mtimeMs <= sinceMs) return false
        const dst = path.join(outDir, rel)
        await mkdir(path.dirname(dst), { recursive: true })
        const written = await Bun.write(dst, Bun.file(src))
        bytes += written
        return true
      }

      const renderSibling = async (rel: string): Promise<void> => {
        const jsonlPath = path.join(outDir, rel)
        const jsonlText = await Bun.file(jsonlPath).text()
        const md = renderClaudeSession(jsonlText)
        const mdPath = jsonlPath.replace(/\.jsonl$/, '.md')
        await Bun.write(mdPath, md)
      }

      const sessions = new Glob('**/*.jsonl')
      for await (const rel of sessions.scan({
        cwd: opts.sourceDir,
        absolute: false,
        onlyFiles: true,
      })) {
        if (rel.split(path.sep).includes('subagents')) continue
        if (await copyIfFresh(rel)) {
          sessionsPulled += 1
          await renderSibling(rel)
        }
      }

      const memories = new Glob('*/memory/*.md')
      for await (const rel of memories.scan({
        cwd: opts.sourceDir,
        absolute: false,
        onlyFiles: true,
      })) {
        if (await copyIfFresh(rel)) memoriesPulled += 1
      }

      return {
        sessions_pulled: sessionsPulled,
        memories_pulled: memoriesPulled,
        bytes,
      }
    },
  }
}

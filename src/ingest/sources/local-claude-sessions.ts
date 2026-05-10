import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { Glob } from 'bun'

import type { Source } from '#src/ingest/orchestrator'

export function ingestLocalClaudeSessions(opts: {
  machine: string
  sourceDir: string
}): Source {
  return {
    machine: opts.machine,
    source: 'claude-sessions',
    pull: async ({ outDir, since }) => {
      const glob = new Glob('**/*.jsonl')
      const sinceMs = since.getTime()
      let filesPulled = 0
      let bytes = 0

      for await (const rel of glob.scan({
        cwd: opts.sourceDir,
        absolute: false,
        onlyFiles: true,
      })) {
        if (rel.split(path.sep).includes('subagents')) continue
        const src = path.join(opts.sourceDir, rel)
        const info = await stat(src)
        if (info.mtimeMs <= sinceMs) continue
        const dst = path.join(outDir, rel)
        await mkdir(path.dirname(dst), { recursive: true })
        const written = await Bun.write(dst, Bun.file(src))
        filesPulled += 1
        bytes += written
      }
      return { files_pulled: filesPulled, bytes }
    },
  }
}

import { renderSession } from '#lib/renderer/render'

import { parseTree } from './entries.ts'
import { normalizeTree } from './normalize.ts'
import { piFallback, piTools } from './tools.ts'

export function renderPiSession(jsonlText: string): string {
  return renderSession(normalizeTree(parseTree(jsonlText)), {
    preprocess: () => undefined as void,
    tools: piTools,
    fallback: piFallback,
  })
}

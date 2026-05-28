import { renderSession } from '#lib/renderer/render'

import { normalize } from './normalize.ts'
import { codexFallback, codexTools } from './tools.ts'

export function renderCodexSession(jsonlText: string): string {
  return renderSession(normalize(jsonlText), {
    preprocess: () => undefined as void,
    tools: codexTools,
    fallback: codexFallback,
  })
}

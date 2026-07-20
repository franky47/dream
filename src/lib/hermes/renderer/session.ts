import { renderSession } from '#lib/renderer/render'

import { normalize } from './normalize.ts'
import { hermesFallback, hermesTools } from './tools.ts'

export function renderHermesSession(jsonlText: string): string {
  return renderSession(normalize(jsonlText), {
    preprocess: () => undefined as void,
    tools: hermesTools,
    fallback: hermesFallback,
  })
}

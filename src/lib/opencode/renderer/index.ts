import { renderSession } from '#lib/renderer/render'

import { normalize } from './normalize.ts'
import { opencodeFallback, opencodeTools } from './tools.ts'

export function renderOpencodeSession(jsonlText: string): string {
  return renderSession(normalize(jsonlText), {
    preprocess: () => undefined as void,
    tools: opencodeTools,
    fallback: opencodeFallback,
  })
}

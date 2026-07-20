import { renderSession } from '#lib/renderer/render'
import type { RenderConfig } from '#lib/renderer/types'

import { normalize } from './normalize.ts'
import { hermesFallback, hermesTools } from './tools.ts'

export const hermesRenderConfig: RenderConfig<void> = {
  preprocess: () => undefined as void,
  tools: hermesTools,
  fallback: hermesFallback,
}

export function renderHermesSession(jsonlText: string): string {
  return renderSession(normalize(jsonlText), hermesRenderConfig)
}

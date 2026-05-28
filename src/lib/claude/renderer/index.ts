import { renderSession } from '#lib/renderer/render'

import { normalize } from './normalize.ts'
import { claudePreprocess } from './preprocess.ts'
import { claudeFallback, claudeTools } from './tools.ts'

export function renderClaudeSession(jsonlText: string): string {
  return renderSession(normalize(jsonlText), {
    preprocess: claudePreprocess,
    tools: claudeTools,
    fallback: claudeFallback,
  })
}

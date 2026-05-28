import type {
  NormalizedMessage,
  NormalizedSession,
  Part,
  RenderConfig,
  RenderCtx,
  Role,
} from './types.ts'

function formatDelta(startMs: number, currentMs: number): string {
  const totalSec = Math.max(0, Math.round((currentMs - startMs) / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `+${m}m${s.toString().padStart(2, '0')}s`
}

function turnMarker(n: number, role: Role, t: string | null): string {
  const tAttr = t === null ? '' : ` t="${t}"`
  return `<turn n="${n}" role="${role}"${tAttr}/>`
}

function renderTextPart(part: Extract<Part, { kind: 'text' }>): string {
  return part.text.trim()
}

function renderToolPart<S>(
  part: Extract<Part, { kind: 'tool' }>,
  config: RenderConfig<S>,
  ctx: RenderCtx<S>,
): string {
  const renderer = config.tools[part.name] ?? config.fallback
  return renderer(part, ctx)
}

function renderMessageBody<S>(
  msg: NormalizedMessage,
  config: RenderConfig<S>,
  ctx: RenderCtx<S>,
): string {
  const out: string[] = []
  for (const part of msg.parts) {
    const rendered =
      part.kind === 'text'
        ? renderTextPart(part)
        : renderToolPart(part, config, ctx)
    if (rendered.length > 0) out.push(rendered)
  }
  return out.join('\n')
}

export function renderSession<S>(
  session: NormalizedSession,
  config: RenderConfig<S>,
): string {
  const state = config.preprocess(session.messages)
  const ctx: RenderCtx<S> = { state }

  let firstStampMs: number | null = null
  const bodyParts: string[] = []
  let n = 0
  for (const msg of session.messages) {
    n += 1
    let t: string | null
    if (msg.timestampMs === null) {
      t = null
    } else if (firstStampMs === null) {
      firstStampMs = msg.timestampMs
      t = '0'
    } else {
      t = formatDelta(firstStampMs, msg.timestampMs)
    }
    bodyParts.push(turnMarker(n, msg.role, t))
    const body = renderMessageBody(msg, config, ctx)
    if (body.length > 0) bodyParts.push(body)
  }

  return `${session.frontmatterYaml}\n${bodyParts.join('\n')}\n`
}

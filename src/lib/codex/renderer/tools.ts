import type { ToolPart, ToolRenderer } from '#lib/renderer/types'

function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\t', '&#9;')
}

function renderInputAttrs(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') parts.push(`${k}="${escapeAttr(v)}"`)
    else if (typeof v === 'number' || typeof v === 'boolean')
      parts.push(`${k}="${String(v)}"`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

export const codexFallback: ToolRenderer<void> = (tool: ToolPart): string => {
  const attrs = renderInputAttrs(tool.input)
  const errorAttr = tool.result?.isError === true ? ' error="1"' : ''
  return `<tool name="${escapeAttr(tool.name)}"${attrs}${errorAttr}/>`
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

interface ExecEnvelope {
  exit: string
  wall: string
  body: string
}

function parseExecEnvelope(content: string): ExecEnvelope | null {
  const lines = content.split('\n')
  let exit: string | null = null
  let wall: string | null = null
  let outputStart: number | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (wall === null && line.startsWith('Wall time: ')) {
      wall = line.slice('Wall time: '.length)
    } else if (exit === null && line.startsWith('Process exited with code: ')) {
      exit = line.slice('Process exited with code: '.length)
    } else if (line === 'Output:' && lines[i + 1] === '---') {
      outputStart = i + 2
      break
    }
  }
  if (exit === null || wall === null || outputStart === null) return null
  const body = lines.slice(outputStart).join('\n').replace(/\n+$/, '')
  return { exit, wall, body }
}

const renderExecCommand: ToolRenderer<void> = (tool) => {
  const cmd = asString(tool.input.cmd)
  const cmdAttr = `cmd="${escapeAttr(cmd)}"`
  if (tool.result === undefined) {
    return `<tool name="exec_command" ${cmdAttr}/>`
  }
  const env = parseExecEnvelope(tool.result.content)
  if (env === null) {
    return `<tool name="exec_command" ${cmdAttr}/>`
  }
  const errorAttr = tool.result.isError ? ' error="1"' : ''
  const head = `<tool name="exec_command" ${cmdAttr} exit="${escapeAttr(env.exit)}" wall="${escapeAttr(env.wall)}"`
  if (env.body.length === 0) {
    return `${head}${errorAttr}/>`
  }
  return `${head}${errorAttr}>\n${env.body}\n</tool>`
}

function parseExitCode(content: string): string | null {
  const m = content.match(/^Exit code: (\S+)/)
  return m === null ? null : (m[1] ?? null)
}

interface PatchFile {
  op: 'add' | 'update' | 'delete'
  path: string
  movedTo: string | null
  body: string[]
}

function parsePatchScript(raw: string): PatchFile[] {
  const lines = raw.split('\n')
  const files: PatchFile[] = []
  let current: PatchFile | null = null
  const push = (): void => {
    if (current !== null) files.push(current)
    current = null
  }
  for (const line of lines) {
    if (line === '*** Begin Patch' || line === '*** End Patch') {
      push()
      continue
    }
    if (line.startsWith('*** Add File: ')) {
      push()
      current = {
        op: 'add',
        path: line.slice('*** Add File: '.length),
        movedTo: null,
        body: [],
      }
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      push()
      current = {
        op: 'update',
        path: line.slice('*** Update File: '.length),
        movedTo: null,
        body: [],
      }
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      push()
      current = {
        op: 'delete',
        path: line.slice('*** Delete File: '.length),
        movedTo: null,
        body: [],
      }
      continue
    }
    if (line.startsWith('*** Move to: ') && current !== null) {
      current.movedTo = line.slice('*** Move to: '.length)
      continue
    }
    if (current !== null) current.body.push(line)
  }
  push()
  return files
}

function fileHeaders(file: PatchFile): string[] {
  if (file.op === 'add') return ['--- /dev/null', `+++ b/${file.path}`]
  if (file.op === 'delete') return [`--- a/${file.path}`, '+++ /dev/null']
  const dst = file.movedTo ?? file.path
  return [`--- a/${file.path}`, `+++ b/${dst}`]
}

function renderPatchAsDiff(raw: string): string {
  const files = parsePatchScript(raw)
  const out: string[] = []
  for (const file of files) {
    out.push(...fileHeaders(file))
    out.push(...file.body)
  }
  return out.join('\n')
}

const renderApplyPatch: ToolRenderer<void> = (tool) => {
  const raw = asString(tool.input._raw)
  if (raw.length === 0) {
    return '<tool name="apply_patch"/>'
  }
  const diff = renderPatchAsDiff(raw)
  const exit =
    tool.result === undefined ? null : parseExitCode(tool.result.content)
  const exitAttr = exit === null ? '' : ` exit="${escapeAttr(exit)}"`
  const errorAttr = tool.result?.isError === true ? ' error="1"' : ''
  return `<tool name="apply_patch"${exitAttr}${errorAttr}>\n${diff}\n</tool>`
}

export const codexTools: Record<string, ToolRenderer<void>> = {
  exec_command: renderExecCommand,
  apply_patch: renderApplyPatch,
}

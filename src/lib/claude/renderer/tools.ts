import { diffLines } from 'diff'

export interface ToolUseInput {
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  content: string
  isError: boolean
}

const BASH_MAX_LINES = 200
const BASH_MAX_BYTES = 8 * 1024
const BASH_HEAD_LINES = 40
const BASH_TAIL_LINES = 40
const BASH_HEAD_BYTES = 4 * 1024
const BASH_TAIL_BYTES = 4 * 1024

const WRITE_VERBATIM_LINES = 60
const WRITE_HEAD_LINES = 30
const WRITE_TAIL_LINES = 10

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function attrEscape(s: string): string {
  return s.replaceAll('"', '&quot;')
}

function countLines(s: string): number {
  if (s.length === 0) return 0
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s
  if (trimmed.length === 0) return 0
  let n = 1
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) === 10) n += 1
  }
  return n
}

function trimTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s
}

function headTailLines(text: string, headN: number, tailN: number): string {
  const lines = text.split('\n')
  if (lines.length <= headN + tailN) return text
  const head = lines.slice(0, headN)
  const tail = lines.slice(lines.length - tailN)
  const elided = lines.length - headN - tailN
  return [...head, `... (${elided} lines elided)`, ...tail].join('\n')
}

function headTailBytes(
  text: string,
  headBytes: number,
  tailBytes: number,
): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= headBytes + tailBytes) return text
  const head = buf.subarray(0, headBytes).toString('utf8')
  const tail = buf.subarray(buf.length - tailBytes).toString('utf8')
  const elided = buf.length - headBytes - tailBytes
  return `${head}\n... (${elided} bytes elided)\n${tail}`
}

function bashBody(content: string): string {
  const lineCount = countLines(content)
  const byteLen = Buffer.byteLength(content, 'utf8')
  const overLines = lineCount > BASH_MAX_LINES
  const overBytes = byteLen > BASH_MAX_BYTES
  if (!overLines && !overBytes) return trimTrailingNewline(content)
  if (overLines) {
    return headTailLines(
      trimTrailingNewline(content),
      BASH_HEAD_LINES,
      BASH_TAIL_LINES,
    )
  }
  return headTailBytes(
    trimTrailingNewline(content),
    BASH_HEAD_BYTES,
    BASH_TAIL_BYTES,
  )
}

export function renderBashTool(
  use: ToolUseInput,
  result: ToolResult | undefined,
): string {
  const cmd = asString(use.input.command)
  const cmdAttr = `cmd="${attrEscape(cmd)}"`
  if (result === undefined) {
    return `<tool name="Bash" ${cmdAttr}/>`
  }
  const exit = result.isError ? 1 : 0
  const body = bashBody(result.content)
  return `<tool name="Bash" ${cmdAttr} exit="${exit}">\n${body}\n</tool>`
}

export function renderWriteTool(use: ToolUseInput): string {
  const file = asString(use.input.file_path)
  const content = asString(use.input.content)
  const lines = countLines(content)
  const bytes = Buffer.byteLength(content, 'utf8')
  const fileAttr = `file="${attrEscape(file)}"`
  const head = `<tool name="Write" ${fileAttr} lines="${lines}" bytes="${bytes}">`
  const trimmed = trimTrailingNewline(content)
  const body =
    lines <= WRITE_VERBATIM_LINES
      ? trimmed
      : headTailLines(trimmed, WRITE_HEAD_LINES, WRITE_TAIL_LINES)
  return `${head}\n${body}\n</tool>`
}

function unifiedDiffBody(oldStr: string, newStr: string): string {
  const changes = diffLines(oldStr, newStr)
  const out: string[] = []
  for (const c of changes) {
    const prefix = c.added ? '+' : c.removed ? '-' : ' '
    const lines = c.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) out.push(prefix + line)
  }
  return out.join('\n')
}

export function renderEditTool(uses: ToolUseInput[]): string {
  const first = uses[0]
  if (first === undefined) return ''
  const file = asString(first.input.file_path)
  const fileAttr = `file="${attrEscape(file)}"`
  const diffs = uses.map((u) =>
    unifiedDiffBody(asString(u.input.old_string), asString(u.input.new_string)),
  )
  return `<tool name="Edit" ${fileAttr} patches="${uses.length}">\n${diffs.join('\n')}\n</tool>`
}

const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function trimTrailingWhitespace(s: string): string {
  return s.replace(/[ \t]+$/gm, '')
}

export function collapseBlankRuns(s: string): string {
  const lines = s.split('\n')
  const out: string[] = []
  let blankRun = 0
  for (const line of lines) {
    const isBlank = /^[ \t]*$/.test(line)
    if (isBlank) {
      blankRun += 1
      if (blankRun <= 1) out.push(line)
    } else {
      blankRun = 0
      out.push(line)
    }
  }
  return out.join('\n')
}

export function applyPostPasses(s: string): string {
  return collapseBlankRuns(trimTrailingWhitespace(stripAnsi(s)))
}

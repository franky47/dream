export type Role = 'user' | 'assistant'

interface TextPart {
  kind: 'text'
  text: string
}

export interface ToolResult {
  content: string
  isError: boolean
  details?: unknown
}

export interface ToolPart {
  kind: 'tool'
  id: string
  name: string
  input: Record<string, unknown>
  result?: ToolResult
}

export type Part = TextPart | ToolPart

export interface NormalizedMessage {
  role: Role
  timestampMs: number | null
  parts: Part[]
}

export interface NormalizedSession {
  frontmatterYaml: string
  messages: NormalizedMessage[]
}

export interface RenderCtx<S> {
  state: S
}

export type ToolRenderer<S> = (tool: ToolPart, ctx: RenderCtx<S>) => string

export interface RenderConfig<S> {
  preprocess: (messages: readonly NormalizedMessage[]) => S
  tools: Record<string, ToolRenderer<S>>
  fallback: ToolRenderer<S>
}

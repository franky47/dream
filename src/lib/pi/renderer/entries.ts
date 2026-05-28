import { z } from 'zod'

const sessionHeaderSchema = z.object({
  type: z.literal('session'),
  version: z.number(),
  id: z.string(),
  timestamp: z.string(),
  cwd: z.string(),
  parentSession: z.string().nullable().optional(),
})

const nodeBaseSchema = z
  .object({
    type: z.string(),
    id: z.string(),
    parentId: z.string().nullable(),
    timestamp: z.string(),
  })
  .passthrough()

type SessionHeader = z.infer<typeof sessionHeaderSchema>
export type Node = z.infer<typeof nodeBaseSchema>

export interface PiTree {
  header: SessionHeader | null
  nodes: Map<string, Node>
  childrenById: Map<string, string[]>
}

export function parseTree(jsonlText: string): PiTree {
  let header: SessionHeader | null = null
  const nodes = new Map<string, Node>()
  const childrenById = new Map<string, string[]>()

  for (const line of jsonlText.split('\n')) {
    if (line.length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const head = sessionHeaderSchema.safeParse(raw)
    if (head.success) {
      header ??= head.data
      continue
    }
    const node = nodeBaseSchema.safeParse(raw)
    if (!node.success) continue
    if (nodes.has(node.data.id)) continue
    nodes.set(node.data.id, node.data)
    const parent = node.data.parentId
    if (parent !== null) {
      const list = childrenById.get(parent)
      if (list === undefined) childrenById.set(parent, [node.data.id])
      else list.push(node.data.id)
    }
  }

  return { header, nodes, childrenById }
}

function timestampMs(node: Node): number {
  const t = Date.parse(node.timestamp)
  return Number.isFinite(t) ? t : 0
}

function pickActiveLeaf(tree: PiTree): Node | null {
  let best: Node | null = null
  for (const node of tree.nodes.values()) {
    const hasChildren = (tree.childrenById.get(node.id)?.length ?? 0) > 0
    if (hasChildren) continue
    if (best === null || timestampMs(node) > timestampMs(best)) best = node
  }
  return best
}

export function activePath(tree: PiTree): Node[] {
  const leaf = pickActiveLeaf(tree)
  if (leaf === null) return []
  const path: Node[] = []
  let current: Node | undefined = leaf
  const seen = new Set<string>()
  while (current !== undefined) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    path.push(current)
    const parentId = current.parentId
    if (parentId === null) break
    current = tree.nodes.get(parentId)
  }
  return path.reverse()
}

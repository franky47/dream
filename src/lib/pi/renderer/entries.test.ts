import { describe, expect, test } from 'bun:test'

import { activePath, parseTree } from './entries.ts'

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const sessionHeader = {
  type: 'session',
  version: 3,
  id: 'ses_1',
  timestamp: '2026-05-17T09:13:55.629Z',
  cwd: '/repo',
}

function node(id: string, parentId: string | null, ts: string): unknown {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: ts,
    message: { role: 'user', content: [] },
  }
}

describe('parseTree', () => {
  test('captures session header when present', () => {
    const tree = parseTree(jsonl(sessionHeader))
    expect(tree.header?.id).toBe('ses_1')
    expect(tree.header?.cwd).toBe('/repo')
    expect(tree.header?.version).toBe(3)
  })

  test('header is null when missing', () => {
    const tree = parseTree(jsonl(node('a', null, '2026-05-17T09:15:00.000Z')))
    expect(tree.header).toBeNull()
  })

  test('first session header wins when multiple present', () => {
    const tree = parseTree(
      jsonl(sessionHeader, {
        type: 'session',
        version: 3,
        id: 'ses_2',
        timestamp: '2026-05-17T10:00:00.000Z',
        cwd: '/other',
      }),
    )
    expect(tree.header?.id).toBe('ses_1')
  })

  test('skips malformed JSON lines silently', () => {
    const text = `${JSON.stringify(sessionHeader)}\nnot-json\n${JSON.stringify(
      node('a', null, '2026-05-17T09:15:00.000Z'),
    )}`
    const tree = parseTree(text)
    expect(tree.header?.id).toBe('ses_1')
    expect(tree.nodes.has('a')).toBe(true)
  })

  test('blank lines do not produce nodes', () => {
    const text = `\n${JSON.stringify(sessionHeader)}\n\n`
    const tree = parseTree(text)
    expect(tree.nodes.size).toBe(0)
  })

  test('duplicate ids are deduplicated (first wins)', () => {
    const tree = parseTree(
      jsonl(
        node('a', null, '2026-05-17T09:15:00.000Z'),
        node('a', null, '2026-05-17T09:16:00.000Z'),
      ),
    )
    expect(tree.nodes.size).toBe(1)
    expect(tree.nodes.get('a')?.timestamp).toBe('2026-05-17T09:15:00.000Z')
  })

  test('childrenById links nodes by parentId', () => {
    const tree = parseTree(
      jsonl(
        node('root', null, '2026-05-17T09:15:00.000Z'),
        node('a', 'root', '2026-05-17T09:15:01.000Z'),
        node('b', 'root', '2026-05-17T09:15:02.000Z'),
      ),
    )
    expect(tree.childrenById.get('root')?.sort()).toEqual(['a', 'b'])
  })
})

describe('activePath', () => {
  test('returns [] for an empty tree', () => {
    const tree = parseTree('')
    expect(activePath(tree)).toEqual([])
  })

  test('linear chain: walks leaf → root, returns root-first ordering', () => {
    const tree = parseTree(
      jsonl(
        node('r', null, '2026-05-17T09:15:00.000Z'),
        node('m', 'r', '2026-05-17T09:15:01.000Z'),
        node('l', 'm', '2026-05-17T09:15:02.000Z'),
      ),
    )
    const path = activePath(tree)
    expect(path.map((n) => n.id)).toEqual(['r', 'm', 'l'])
  })

  test('branching tree: picks the latest-timestamp leaf', () => {
    const tree = parseTree(
      jsonl(
        node('r', null, '2026-05-17T09:15:00.000Z'),
        node('a', 'r', '2026-05-17T09:15:01.000Z'),
        node('b', 'r', '2026-05-17T09:16:00.000Z'),
      ),
    )
    const path = activePath(tree)
    expect(path.map((n) => n.id)).toEqual(['r', 'b'])
  })

  test('orphan parentId terminates the walk gracefully', () => {
    const tree = parseTree(
      jsonl(node('a', 'missing-parent', '2026-05-17T09:15:00.000Z')),
    )
    const path = activePath(tree)
    expect(path.map((n) => n.id)).toEqual(['a'])
  })

  test('cycle in parentId chain is broken by the seen-set guard', () => {
    // a → b → a (cycle). Both have a sibling-less child status; pick any leaf.
    const tree = parseTree(
      jsonl(
        node('a', 'b', '2026-05-17T09:15:00.000Z'),
        node('b', 'a', '2026-05-17T09:15:01.000Z'),
      ),
    )
    // Both have a child (each other) so technically no leaves; activePath
    // returns [] when no leaf qualifies.
    const path = activePath(tree)
    expect(path).toEqual([])
  })

  test('single node with no parent and no children is the active path', () => {
    const tree = parseTree(
      jsonl(node('only', null, '2026-05-17T09:15:00.000Z')),
    )
    const path = activePath(tree)
    expect(path.map((n) => n.id)).toEqual(['only'])
  })
})

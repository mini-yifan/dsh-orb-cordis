/**
 * Turn one snapshot into a small indented outline.
 *
 * The library returns a full tree; the model needs a map. Three rules keep the
 * result inside a tool-result budget:
 * - anonymous single-child wrappers collapse, because web content nests dozens
 *   of `group` nodes that carry nothing but `SetFocus`;
 * - `SetFocus` alone never justifies a line, and is dropped from the action list
 *   when a real action exists;
 * - the walk stops at a node budget instead of cutting a JSON string in half.
 * @module @dsh-orb/desktop/src/render
 */

import type { DesktopNode, SnapshotData } from './protocol.ts'

export interface RenderOptions {
  /** Most nodes rendered. */
  readonly maxNodes?: number
  /** Most characters rendered. */
  readonly maxChars?: number
}

export interface RenderedTree {
  readonly text: string
  /** Every ref that reached the model; the session refuses refs outside this set. */
  readonly refs: readonly string[]
  readonly nodes: number
  /** Whether the node or character budget cut something. */
  readonly truncated: boolean
}

const DEFAULT_MAX_NODES = 140
const DEFAULT_MAX_CHARS = 6000
const MAX_NAME = 80
const MAX_VALUE = 120

const ACTION_NOISE = new Set(['SetFocus', 'setfocus', 'Focus'])

function trimText(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1)}…`
}

/** Actions worth showing, with the pure focus hints removed. */
function meaningfulActions(node: DesktopNode): string[] {
  const actions = node.actions ?? []
  const real = actions.filter(action => !ACTION_NOISE.has(action))
  return (real.length > 0 ? real : []).slice(0, 3)
}

function isAnonymousWrapper(node: DesktopNode): boolean {
  if (node.ref !== undefined) return false
  if (node.name !== undefined && node.name !== '') return false
  if (node.value !== undefined && node.value !== '') return false
  const children = node.children ?? []
  if (children.length !== 1) return false
  return meaningfulActions(node).length === 0
}

function nodeLine(node: DesktopNode): string {
  const parts: string[] = [node.role]
  if (node.name !== undefined && node.name !== '') parts.push(`"${trimText(node.name, MAX_NAME)}"`)
  if (node.value !== undefined && node.value !== '') parts.push(`= "${trimText(node.value, MAX_VALUE)}"`)
  const actions = meaningfulActions(node)
  if (actions.length > 0) parts.push(`[${actions.join(' ')}]`)
  if (node.ref !== undefined) parts.push(`{${node.ref}}`)
  const states = (node.states ?? []).filter(state => state !== 'enabled')
  if (states.length > 0) parts.push(`(${states.join(' ')})`)
  return parts.join(' ')
}

/**
 * Render one snapshot.
 * @param snapshot - normalized observation.
 * @param options - budget overrides.
 * @returns the outline, its refs, and whether anything was cut.
 */
export function renderSnapshot(snapshot: SnapshotData, options: RenderOptions = {}): RenderedTree {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const lines: string[] = []
  const refs: string[] = []
  let nodes = 0
  let chars = 0
  let truncated = false

  const head = [`app "${snapshot.app || 'unknown'}"`]
  if (snapshot.windowTitle !== undefined && snapshot.windowTitle !== '') {
    head.push(`window "${trimText(snapshot.windowTitle, MAX_NAME)}"`)
  }
  head.push(`snapshot ${snapshot.snapshotId || '?'}`)
  head.push(`${snapshot.refCount} refs`)
  if (!snapshot.complete) head.push('INCOMPLETE')
  lines.push(head.join(' · '))

  const walk = (node: DesktopNode, depth: number): void => {
    if (truncated) return
    if (nodes >= maxNodes || chars >= maxChars) {
      truncated = true
      return
    }
    if (isAnonymousWrapper(node)) {
      const child = node.children?.[0]
      if (child !== undefined) {
        walk(child, depth)
        return
      }
    }
    nodes += 1
    const indent = '  '.repeat(depth)
    lines.push(`${indent}${nodeLine(node)}`)
    chars += indent.length + nodeLine(node).length + 1
    if (node.ref !== undefined) refs.push(node.ref)
    const children = node.children ?? []
    if (node.childrenCount !== undefined && node.childrenCount > 0 && children.length === 0) {
      const note = `${indent}  … ${node.childrenCount} hidden by depth (snapshot a deeper level)`
      lines.push(note)
      chars += note.length + 1
      return
    }
    for (const [index, child] of children.entries()) {
      if (truncated) break
      if (nodes >= maxNodes) {
        const rest = children.length - index
        lines.push(`${indent}  … ${rest} more here (raise max_nodes to see them)`)
        truncated = true
        break
      }
      walk(child, depth + 1)
    }
  }

  walk(snapshot.tree, 0)

  if (snapshot.complete === false) {
    lines.push('note: the observation budget ran out; treat this as partial and re-snapshot deeper only where needed.')
  }
  if (truncated) {
    lines.push('note: output cut at the node budget; re-snapshot with a deeper level or a larger max_nodes for the part you need.')
  }
  return { text: lines.join('\n'), refs, nodes, truncated }
}
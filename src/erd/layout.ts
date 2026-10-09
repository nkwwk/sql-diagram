import { graphlib, layout as dagreLayout } from '@dagrejs/dagre'
import type { Node } from '@xyflow/react'
import type { Schema, Table } from '../sql/types'

export const HEADER_HEIGHT = 40
export const ROW_HEIGHT = 26

export type TableNodeData = {
  table: Table
  fkTargets: Record<string, string>
  dim: boolean
  active: boolean
}

export type TableNodeType = Node<TableNodeData, 'table'>

export type Direction = 'LR' | 'TB'

export function nodeSize(t: Table) {
  const longest = Math.max(
    t.id.length * 8.2 + 40,
    ...t.columns.map((c) => c.name.length * 7.4 + Math.min(c.type.length, 28) * 6.9 + 104),
  )
  return {
    width: Math.round(Math.min(Math.max(longest, 220), 440)),
    height: HEADER_HEIGHT + Math.max(t.columns.length, 1) * ROW_HEIGHT + 2,
  }
}

function fkTargets(schema: Schema, t: Table) {
  const map: Record<string, string> = {}
  for (const r of schema.relationships) {
    if (r.from !== t.id) continue
    r.fromColumns.forEach((c, i) => {
      map[c.toLowerCase()] = `${r.to}.${r.toColumns[i] ?? r.toColumns[0] ?? ''}`
    })
  }
  return map
}

/**
 * Lays out connected tables with dagre (parents before children) and packs
 * tables without any relationship into a grid underneath.
 */
export function layoutSchema(schema: Schema, direction: Direction): TableNodeType[] {
  const sizes = new Map(schema.tables.map((t) => [t.id, nodeSize(t)]))
  const linked = new Set<string>()
  for (const r of schema.relationships) {
    if (r.from === r.to) continue
    linked.add(r.from)
    linked.add(r.to)
  }

  const g = new graphlib.Graph({ multigraph: true })
  g.setGraph({ rankdir: direction, nodesep: 50, ranksep: direction === 'LR' ? 110 : 80, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const t of schema.tables) if (linked.has(t.id)) g.setNode(t.id, { ...sizes.get(t.id)! })
  for (const r of schema.relationships) if (r.from !== r.to) g.setEdge(r.to, r.from, {}, r.id)
  dagreLayout(g)

  const positions = new Map<string, { x: number; y: number }>()
  let maxY = 0
  let maxX = 0
  for (const id of g.nodes()) {
    const n = g.node(id)
    const x = n.x - n.width / 2
    const y = n.y - n.height / 2
    positions.set(id, { x, y })
    maxY = Math.max(maxY, y + n.height)
    maxX = Math.max(maxX, x + n.width)
  }

  const loose = schema.tables.filter((t) => !linked.has(t.id))
  if (loose.length) {
    const perRow = Math.max(Math.ceil(Math.sqrt(loose.length * 1.6)), Math.floor(maxX / 280), 1)
    let x = 20
    let y = linked.size ? maxY + 100 : 20
    let rowHeight = 0
    loose.forEach((t, i) => {
      const s = sizes.get(t.id)!
      if (i > 0 && i % perRow === 0) {
        x = 20
        y += rowHeight + 50
        rowHeight = 0
      }
      positions.set(t.id, { x, y })
      x += s.width + 50
      rowHeight = Math.max(rowHeight, s.height)
    })
  }

  return schema.tables.map((t) => ({
    id: t.id,
    type: 'table',
    position: positions.get(t.id) ?? { x: 0, y: 0 },
    style: { width: sizes.get(t.id)!.width },
    data: { table: t, fkTargets: fkTargets(schema, t), dim: false, active: false },
  }))
}

/** Bounding box of laid-out nodes, using the same size estimate the layout used. */
export function layoutBounds(nodes: TableNodeType[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const { width, height } = nodeSize(n.data.table)
    minX = Math.min(minX, n.position.x)
    minY = Math.min(minY, n.position.y)
    maxX = Math.max(maxX, n.position.x + width)
    maxY = Math.max(maxY, n.position.y + height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

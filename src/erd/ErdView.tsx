import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  type Edge,
} from '@xyflow/react'
import { toPng } from 'html-to-image'
import '@xyflow/react/dist/style.css'
import type { Schema } from '../sql/types'
import TableNode from './TableNode'
import { layoutBounds, layoutSchema, type Direction, type TableNodeType } from './layout'
import { downloadDataUrl } from '../util/download'
import { useIsNarrow } from '../util/useMediaQuery'
import Menu from '../components/Menu'
import TableDetails from './TableDetails'

const nodeTypes = { table: TableNode }
const NO_NODES: TableNodeType[] = []

/** Above this many tables, trade visual extras (minimap, shadows, transitions) for smooth dragging. */
const LARGE_DIAGRAM = 150

function geometry(nodes: TableNodeType[]) {
  return new Map(
    nodes.map((n) => {
      const w = n.measured?.width ?? (n.style?.width as number) ?? 240
      return [n.id, { cx: n.position.x + w / 2, w }]
    }),
  )
}

function Markers() {
  const defs = (suffix: string) => (
    <>
      <marker id={`m-many${suffix}`} viewBox="0 0 24 24" refX="24" refY="12" markerWidth="22" markerHeight="22" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M10 12 L24 3 M10 12 L24 12 M10 12 L24 21" />
      </marker>
      <marker id={`m-zero-one${suffix}`} viewBox="0 0 24 24" refX="24" refY="12" markerWidth="22" markerHeight="22" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <circle cx="9" cy="12" r="4" />
        <path d="M19 4 L19 20" />
      </marker>
      <marker id={`m-one${suffix}`} viewBox="0 0 24 24" refX="24" refY="12" markerWidth="22" markerHeight="22" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M14 4 L14 20 M19 4 L19 20" />
      </marker>
    </>
  )
  return (
    <svg className="erd-markers" width="0" height="0" aria-hidden>
      <defs>
        <g className="erd-markers--normal">{defs('')}</g>
        <g className="erd-markers--active">{defs('-hl')}</g>
      </defs>
    </svg>
  )
}

interface Props {
  schema: Schema
  fileName: string
}

function ErdCanvas({ schema, fileName }: Props) {
  const narrow = useIsNarrow()
  // Portrait phones fit a top-to-bottom layout much better.
  const [direction, setDirection] = useState<Direction>(() => (narrow ? 'TB' : 'LR'))
  const [selected, setSelected] = useState<string | null>(null)
  const [showLabels, setShowLabels] = useState(false)
  const [query, setQuery] = useState('')
  // Nodes are owned by React Flow (uncontrolled): routing every drag frame through React state
  // and back into the store re-processes every node and re-runs every handle's subscription.
  const { setNodes, setViewport, setCenter, getNodes } = useReactFlow<TableNodeType, Edge>()
  const container = useRef<HTMLDivElement>(null)
  const large = schema.tables.length > LARGE_DIAGRAM
  /**
   * Node centres used to pick which side each edge attaches to. Updated only after a layout or
   * when a drag ends — deriving it from live positions would rebuild every edge on every drag frame.
   */
  const [geo, setGeo] = useState<Map<string, { cx: number; w: number }>>(() => new Map())

  // Fit from the layout's own geometry: with viewport culling, off-screen nodes are never
  // measured, so waiting for React Flow's measurements would never finish on large schemas.
  // Before React Flow's pan/zoom is ready, viewport changes are dropped; queue the fit until onInit.
  const ready = useRef(false)
  const pendingFit = useRef<TableNodeType[] | null>(null)
  const fitTo = useCallback(
    (laid: TableNodeType[], animate = true) => {
      const el = container.current
      if (!ready.current || !el) {
        pendingFit.current = laid
        return
      }
      if (!laid.length) return
      // Keep the diagram clear of the floating toolbar at the top.
      const toolbar = 56
      const vp = getViewportForBounds(layoutBounds(laid), el.clientWidth, el.clientHeight - toolbar, 0.05, 1, 0.04)
      setViewport({ ...vp, y: vp.y + toolbar }, animate ? { duration: 250 } : undefined)
    },
    [setViewport],
  )
  const onInit = useCallback(() => {
    ready.current = true
    if (pendingFit.current) fitTo(pendingFit.current, false)
    pendingFit.current = null
  }, [fitTo])

  const relayout = useCallback(
    (dir: Direction) => {
      const laid = layoutSchema(schema, dir)
      setSelected(null)
      setNodes(laid)
      setGeo(geometry(laid))
      fitTo(laid)
    },
    [schema, setNodes, fitTo],
  )

  useEffect(() => {
    relayout(direction)
    // Only re-run when the schema changes; direction changes call relayout directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema])

  const related = useMemo(() => {
    if (!selected) return null
    const set = new Set([selected])
    for (const r of schema.relationships) {
      if (r.from === selected) set.add(r.to)
      if (r.to === selected) set.add(r.from)
    }
    return set
  }, [selected, schema])

  // Push highlight state into the node data, touching only nodes whose state changes.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const dim = !!related && !related.has(n.id)
        const active = n.id === selected
        return dim === n.data.dim && active === n.data.active ? n : { ...n, data: { ...n.data, dim, active } }
      }),
    )
  }, [related, selected, setNodes])

  const edges = useMemo<Edge[]>(() => {
    return schema.relationships.flatMap((r) => {
      const s = geo.get(r.from)
      const t = geo.get(r.to)
      if (!s || !t) return []
      let sSide = 'r'
      let tSide = 'l'
      if (r.from === r.to) tSide = 'r'
      else if (Math.abs(s.cx - t.cx) < Math.min(s.w, t.w) / 2) sSide = tSide = 'l'
      else if (t.cx < s.cx) {
        sSide = 'l'
        tSide = 'r'
      }
      const active = !!selected && (r.from === selected || r.to === selected)
      const dim = !!selected && !active
      const hl = active ? '-hl' : ''
      return [
        {
          id: r.id,
          source: r.from,
          target: r.to,
          sourceHandle: `${r.fromColumns[0]}-${sSide}`,
          targetHandle: `${r.toColumns[0]}-${tSide}`,
          type: 'smoothstep',
          markerStart: (r.cardinality === 'one-to-one' ? 'm-zero-one' : 'm-many') + hl,
          markerEnd: (r.optional ? 'm-zero-one' : 'm-one') + hl,
          className: `erd-edge${active ? ' is-active' : ''}${dim ? ' is-dim' : ''}${r.optional ? ' is-optional' : ''}`,
          label: showLabels || active ? `${r.fromColumns.join(', ')} → ${r.toColumns.join(', ')}` : undefined,
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 4,
          zIndex: active ? 10 : 0,
        },
      ]
    })
  }, [geo, schema, selected, showLabels])

  const changeDirection = (d: Direction) => {
    setDirection(d)
    relayout(d)
  }

  const focusTable = (id: string) => {
    const n = getNodes().find((x) => x.id.toLowerCase() === id.toLowerCase())
    if (!n) return
    setSelected(n.id)
    const w = n.measured?.width ?? 240
    const h = n.measured?.height ?? 200
    const zoom = narrow ? 0.8 : 1.1
    // On phones the details sheet covers the lower part of the canvas (below the toolbar),
    // so centre the table in the strip that stays visible.
    let offset = 0
    if (narrow) {
      const paneH = document.querySelector('.erd')?.clientHeight ?? window.innerHeight
      const sheetH = Math.min(window.innerHeight * 0.42, paneH * 0.6)
      const toolbarH = 56
      offset = (paneH / 2 - (toolbarH + (paneH - sheetH)) / 2) / zoom
    }
    setCenter(n.position.x + w / 2, n.position.y + h / 2 + offset, { zoom, duration: 400 })
  }

  const exportPng = async () => {
    const el = document.querySelector<HTMLElement>('.erd .react-flow__viewport')
    if (!el) return
    const bounds = getNodesBounds(getNodes())
    const pad = 40
    const width = Math.min(bounds.width + pad * 2, 8000)
    const height = Math.min(bounds.height + pad * 2, 8000)
    const vp = getViewportForBounds(bounds, width, height, 0.1, 2, 0)
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#fff'
    // Mobile browsers cap canvas size (~16.7 MP on iOS); stay under it.
    const pixelRatio = Math.min(2, Math.sqrt(16_000_000 / (width * height)))
    const url = await toPng(el, {
      backgroundColor: bg,
      width,
      height,
      pixelRatio,
      style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
    })
    downloadDataUrl(url, `${fileName}-erd.png`)
  }

  return (
    <div ref={container} className={`erd${selected ? ' has-selection' : ''}${large ? ' erd--large' : ''}`}>
      <ReactFlow
        defaultNodes={NO_NODES}
        edges={edges}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        onNodeDragStop={() => setGeo(geometry(getNodes()))}
        onInit={onInit}
        onNodeClick={(_, n) => {
          if (selected === n.id) setSelected(null)
          else if (narrow) focusTable(n.id)
          else setSelected(n.id)
        }}
        onPaneClick={() => setSelected(null)}
        nodesConnectable={false}
        edgesFocusable={false}
        onlyRenderVisibleElements={large}
        minZoom={0.05}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <ViewportPortal>
          <Markers />
        </ViewportPortal>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        {!large && <MiniMap pannable zoomable nodeBorderRadius={4} className="erd-minimap" />}
        <Panel position="top-left" className="erd-toolbar">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              focusTable(query.trim())
            }}
          >
            <input
              list="erd-tables"
              value={query}
              placeholder="Find table…"
              aria-label="Find table"
              onChange={(e) => {
                setQuery(e.target.value)
                if (schema.tables.some((t) => t.id === e.target.value)) focusTable(e.target.value)
              }}
            />
            <datalist id="erd-tables">
              {schema.tables.map((t) => (
                <option key={t.id} value={t.id} />
              ))}
            </datalist>
          </form>
          {narrow ? (
            <Menu
              label="Diagram options"
              items={[
                { label: 'Horizontal layout', active: direction === 'LR', onSelect: () => changeDirection('LR') },
                { label: 'Vertical layout', active: direction === 'TB', onSelect: () => changeDirection('TB') },
                { label: 'Re-run auto layout', onSelect: () => relayout(direction) },
                'separator',
                { label: 'Show edge labels', active: showLabels, onSelect: () => setShowLabels((v) => !v) },
                { label: 'Export PNG', onSelect: exportPng },
              ]}
            />
          ) : (
            <>
              <div className="seg" role="group" aria-label="Layout direction">
                {(['LR', 'TB'] as const).map((d) => (
                  <button key={d} className={direction === d ? 'is-on' : ''} onClick={() => changeDirection(d)}>
                    {d === 'LR' ? 'Horizontal' : 'Vertical'}
                  </button>
                ))}
              </div>
              <button onClick={() => relayout(direction)} title="Re-run auto layout">
                Auto layout
              </button>
              <label className="check">
                <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                Edge labels
              </label>
              <button onClick={exportPng}>Export PNG</button>
            </>
          )}
        </Panel>
        {selected && (
          <Panel position={narrow ? 'bottom-center' : 'top-right'} className="erd-details-panel">
            <TableDetails schema={schema} tableId={selected} onSelect={focusTable} onClose={() => setSelected(null)} />
          </Panel>
        )}
        <Panel position="bottom-right" className="erd-legend">
          <svg width="44" height="14" aria-hidden>
            <path d="M0 7 H44" className="legend-line" />
            <path d="M30 7 L44 1 M30 7 L44 13" className="legend-line" />
          </svg>
          many
          <svg width="44" height="14" aria-hidden>
            <path d="M0 7 H44 M34 1 V13 M39 1 V13" className="legend-line" />
          </svg>
          exactly one
          <svg width="44" height="14" aria-hidden>
            <path d="M0 7 H25 M37 7 H44 M39 1 V13" className="legend-line" />
            <circle cx="31" cy="7" r="4" className="legend-line legend-circle" />
          </svg>
          zero or one
        </Panel>
      </ReactFlow>
    </div>
  )
}

export default function ErdView(props: Props) {
  return (
    <ReactFlowProvider>
      <ErdCanvas {...props} />
    </ReactFlowProvider>
  )
}

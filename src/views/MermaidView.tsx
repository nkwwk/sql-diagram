import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useColorScheme } from '../util/useColorScheme'
import { downloadText } from '../util/download'

let renderCount = 0
/** Above this many tables Mermaid can block the page for a long time, so ask first. */
const LARGE_SCHEMA = 150

interface Props {
  code: string
  tableCount: number
  fileName: string
  description: string
  children?: ReactNode
}

export default function MermaidView({ code, tableCount, fileName, description, children }: Props) {
  const scheme = useColorScheme()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const naturalWidth = useRef(0)
  const [confirmed, setConfirmed] = useState(false)
  const blocked = tableCount > LARGE_SCHEMA && !confirmed

  useEffect(() => {
    if (blocked) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const mermaid = (await import('mermaid')).default
      mermaid.initialize({
        startOnLoad: false,
        theme: scheme === 'dark' ? 'dark' : 'neutral',
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: 2_000_000,
        maxEdges: 20_000,
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        er: { useMaxWidth: false },
        class: { useMaxWidth: false },
        flowchart: { useMaxWidth: false, htmlLabels: true },
      })
      try {
        const { svg } = await mermaid.render(`mmd-${++renderCount}`, code)
        if (!cancelled) {
          setSvg(svg)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, scheme, blocked])

  // Fit to width when a new diagram renders.
  useLayoutEffect(() => {
    const stage = stageRef.current
    const el = stage?.querySelector('svg')
    if (!stage || !el) return
    naturalWidth.current = el.viewBox.baseVal?.width || el.getBoundingClientRect().width
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg])

  const fit = () => {
    const stage = stageRef.current
    if (!stage || !naturalWidth.current) return
    setZoom(Math.min(1, Math.max(0.1, (stage.clientWidth - 48) / naturalWidth.current)))
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setShowCode(true)
    }
  }

  return (
    <div className="mermaid-view">
      <div className="view-toolbar">
        <p className="view-desc">{description}</p>
        <div className="view-actions">
          <div className="seg" role="group" aria-label="Zoom">
            <button onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))} aria-label="Zoom out">−</button>
            <button onClick={() => setZoom(1)} title="Actual size">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom((z) => Math.min(4, z * 1.25))} aria-label="Zoom in">+</button>
          </div>
          <button onClick={fit}>Fit</button>
          <button onClick={() => setShowCode((s) => !s)} className={showCode ? 'is-on' : ''}>Mermaid code</button>
          <button onClick={copy}>{copied ? 'Copied' : 'Copy code'}</button>
          <button onClick={() => svg && downloadText(svg, `${fileName}.svg`, 'image/svg+xml')} disabled={!svg}>
            Export SVG
          </button>
        </div>
      </div>
      {children}
      <div className="mermaid-body">
        <div className="mermaid-stage" ref={stageRef}>
          {blocked && (
            <div className="notice">
              <strong>Large schema: {tableCount} tables.</strong>
              <p>
                Static diagrams this size can take a while to lay out and may freeze the tab. The interactive ER diagram,
                Relationships and Data dictionary tabs handle large schemas better.
              </p>
              <button className="primary" onClick={() => setConfirmed(true)}>Render anyway</button>
            </div>
          )}
          {!blocked && loading && !svg && <div className="placeholder">Rendering diagram…</div>}
          {error && (
            <div className="error-box">
              <strong>Mermaid could not render this diagram.</strong>
              <pre>{error}</pre>
            </div>
          )}
          {!error && <div className="mermaid-svg" style={{ zoom }} dangerouslySetInnerHTML={{ __html: svg }} />}
        </div>
        {showCode && (
          <pre className="code-panel">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
}

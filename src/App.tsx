import { useEffect, useMemo, useRef, useState } from 'react'
import { SAMPLE_SQL } from './sql/sample'
import { toMermaidClass, toMermaidEr, toMermaidGraph } from './diagrams/mermaid'
import ErdView from './erd/ErdView'
import MermaidView from './views/MermaidView'
import RelationshipsView from './views/RelationshipsView'
import DataDictionary from './views/DataDictionary'
import FilesPanel from './views/FilesPanel'
import { useImport } from './useImport'
import { formatBytes } from './util/format'

const TABS = [
  { id: 'erd', label: 'ER diagram' },
  { id: 'crowsfoot', label: "Crow's foot" },
  { id: 'class', label: 'UML class' },
  { id: 'graph', label: 'Dependency graph' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'dictionary', label: 'Data dictionary' },
] as const

type TabId = (typeof TABS)[number]['id']
type Panel = 'files' | 'warnings' | null

const ACCEPT = '.sql,.ddl,.txt,.dump,text/plain,application/sql'
let pasteCount = 0

export default function App() {
  const { files, result, progress, error, busy, replaceFiles, addFiles, removeFile } = useImport()
  const [tab, setTab] = useState<TabId>('erd')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [graphDir, setGraphDir] = useState<'LR' | 'TB'>('LR')
  const openInput = useRef<HTMLInputElement>(null)
  const addInput = useRef<HTMLInputElement>(null)

  const schema = result?.schema ?? null
  const baseName = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : 'schema'

  const erCode = useMemo(() => (schema ? toMermaidEr(schema) : ''), [schema])
  const classCode = useMemo(() => (schema ? toMermaidClass(schema) : ''), [schema])
  const graphCode = useMemo(() => (schema ? toMermaidGraph(schema, graphDir) : ''), [schema, graphDir])

  // Keep the latest file handlers for the window-level drop listener.
  const hasFiles = files.length > 0
  const dropRef = useRef<(list: File[]) => void>(() => {})
  useEffect(() => {
    dropRef.current = (list) => (hasFiles ? addFiles(list) : replaceFiles(list))
  }, [hasFiles, addFiles, replaceFiles])

  useEffect(() => {
    let depth = 0
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const list = Array.from(e.dataTransfer?.files ?? [])
      if (list.length) dropRef.current(list)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const loadSample = () => replaceFiles([new File([SAMPLE_SQL], 'sample.sql', { type: 'text/plain' })])
  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? null : p))

  const columnCount = schema?.tables.reduce((n, t) => n + t.columns.length, 0) ?? 0
  const empty = !schema || schema.tables.length === 0
  const pct = progress && progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
            <rect x="2" y="3" width="8" height="7" rx="1.5" />
            <rect x="14" y="14" width="8" height="7" rx="1.5" />
            <path d="M10 6.5h3a2 2 0 0 1 2 2V14" fill="none" />
          </svg>
          <span>SQL Diagram</span>
        </div>
        <div className="import-actions">
          <button className="primary" onClick={() => openInput.current?.click()}>
            Open .sql files
          </button>
          {hasFiles && <button onClick={() => addInput.current?.click()}>Add files</button>}
          <button
            onClick={() => {
              setDraft('')
              setPasteOpen(true)
            }}
          >
            Paste SQL
          </button>
          <button onClick={loadSample}>Load sample</button>
          {hasFiles && (
            <button className="ghost" onClick={() => replaceFiles([])}>
              Clear
            </button>
          )}
          <input
            ref={openInput}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const list = Array.from(e.target.files ?? [])
              if (list.length) replaceFiles(list)
              e.target.value = ''
            }}
          />
          <input
            ref={addInput}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
        </div>
        {(schema || hasFiles) && (
          <div className="stats">
            {hasFiles && (
              <button className={`chip${panel === 'files' ? ' is-on' : ''}`} onClick={() => togglePanel('files')}>
                {files.length === 1 ? <span className="mono">{files[0].name}</span> : `${files.length} files`}
              </button>
            )}
            {schema && (
              <>
                <span><b>{schema.tables.length}</b> tables</span>
                <span><b>{columnCount}</b> columns</span>
                <span><b>{schema.relationships.length}</b> relationships</span>
                {schema.warnings.length > 0 && (
                  <button className="chip warn-chip" onClick={() => togglePanel('warnings')}>
                    {schema.warnings.length} warning{schema.warnings.length === 1 ? '' : 's'}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </header>

      {busy && (
        <div className="progress" role="status">
          <div className="progress__bar" style={{ width: `${progress ? pct : 2}%` }} />
          <span className="progress__text">
            {progress
              ? `Parsing ${progress.name}${progress.fileCount > 1 ? ` (${progress.fileIndex + 1}/${progress.fileCount})` : ''} — ${pct}% · ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`
              : 'Parsing…'}
          </span>
        </div>
      )}
      {error && <div className="warnings">Import failed: {error}</div>}

      {panel === 'files' && hasFiles && (
        <FilesPanel files={files} reports={busy ? null : (result?.files ?? null)} onRemove={removeFile} onAdd={() => addInput.current?.click()} />
      )}
      {panel === 'warnings' && schema && schema.warnings.length > 0 && (
        <div className="warnings">
          <ul>
            {schema.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {empty ? (
        <main className="empty">
          <div className="dropzone" onClick={() => openInput.current?.click()} role="button" tabIndex={0}>
            <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden>
              <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" />
            </svg>
            {busy ? (
              <>
                <h1>Reading {files.length === 1 ? files[0].name : `${files.length} files`}…</h1>
                <p>Large dumps are streamed, so INSERT and COPY data is skipped without being loaded into memory.</p>
              </>
            ) : (
              <>
                <h1>{hasFiles ? 'No tables found' : 'Drop .sql files here'}</h1>
                <p>
                  {hasFiles
                    ? 'The files were read, but they contain no CREATE TABLE statements.'
                    : 'Import one or more schema files or full database dumps to draw ER diagrams, relationships and a data dictionary.'}
                </p>
                <p className="muted small">
                  MySQL / MariaDB · PostgreSQL · SQL Server · SQLite — multi-GB dumps are streamed and parsed locally in your browser.
                </p>
              </>
            )}
            <div className="empty-actions" onClick={(e) => e.stopPropagation()}>
              <button className="primary" onClick={() => openInput.current?.click()}>Choose files</button>
              <button onClick={loadSample}>Try the sample schema</button>
            </div>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'erd' && <ErdView schema={schema} fileName={baseName} />}
            {tab === 'crowsfoot' && (
              <MermaidView
                code={erCode}
                tableCount={schema.tables.length}
                fileName={`${baseName}-crowsfoot`}
                description="Classic crow's foot notation. Solid lines are identifying relationships (FK is part of the PK); dashed lines are non-identifying."
              />
            )}
            {tab === 'class' && (
              <MermaidView
                code={classCode}
                tableCount={schema.tables.length}
                fileName={`${baseName}-class`}
                description="UML class view: + primary key, # foreign key, − other column, ? nullable. Composition (◆) marks identifying relationships."
              />
            )}
            {tab === 'graph' && (
              <MermaidView
                code={graphCode}
                tableCount={schema.tables.length}
                fileName={`${baseName}-graph`}
                description="Table-level dependencies: arrows point from the referencing table to the referenced one. Dashed arrows are optional FKs; hexagons are link tables."
              >
                <div className="seg sub-toggle" role="group" aria-label="Graph direction">
                  {(['LR', 'TB'] as const).map((d) => (
                    <button key={d} className={graphDir === d ? 'is-on' : ''} onClick={() => setGraphDir(d)}>
                      {d === 'LR' ? 'Left → right' : 'Top → bottom'}
                    </button>
                  ))}
                </div>
              </MermaidView>
            )}
            {tab === 'relationships' && <RelationshipsView schema={schema} />}
            {tab === 'dictionary' && <DataDictionary schema={schema} fileName={baseName} multiFile={files.length > 1} />}
          </div>
        </main>
      )}

      {pasteOpen && (
        <div className="modal-backdrop" onClick={() => setPasteOpen(false)}>
          <div className="modal" role="dialog" aria-label="Paste SQL" onClick={(e) => e.stopPropagation()}>
            <h2>Paste SQL</h2>
            {hasFiles && <p className="muted small">The pasted SQL is added alongside the {files.length} file(s) already loaded.</p>}
            <textarea
              autoFocus
              spellCheck={false}
              value={draft}
              placeholder="CREATE TABLE users (id INT PRIMARY KEY, …);"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setPasteOpen(false)}>Cancel</button>
              <button
                className="primary"
                disabled={!draft.trim()}
                onClick={() => {
                  addFiles([new File([draft], `pasted-${++pasteCount}.sql`, { type: 'text/plain' })])
                  setPasteOpen(false)
                }}
              >
                Draw diagrams
              </button>
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="drag-overlay">
          <div>{hasFiles ? 'Drop to add files' : 'Drop your .sql files'}</div>
        </div>
      )}
    </div>
  )
}

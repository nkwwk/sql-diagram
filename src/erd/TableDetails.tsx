import type { Schema } from '../sql/types'

interface Props {
  schema: Schema
  tableId: string
  onSelect: (id: string) => void
  onClose: () => void
}

/** Details for the selected table — the touch-friendly replacement for hover tooltips. */
export default function TableDetails({ schema, tableId, onSelect, onClose }: Props) {
  const table = schema.tables.find((t) => t.id === tableId)
  if (!table) return null
  const outgoing = schema.relationships.filter((r) => r.from === tableId)
  const incoming = schema.relationships.filter((r) => r.to === tableId && r.from !== tableId)
  const refByCol = new Map<string, string>()
  for (const r of outgoing) r.fromColumns.forEach((c, i) => refByCol.set(c.toLowerCase(), `${r.to}.${r.toColumns[i] ?? ''}`))

  const chip = (id: string, label: string, key: string) => (
    <button key={key} className="chip table-chip" onClick={() => onSelect(id)} title={`Go to ${id}`}>
      {label}
    </button>
  )

  return (
    <section className="erd-details" aria-label={`Table ${table.id}`}>
      <header className="erd-details__head">
        <div>
          <h3 className="mono">{table.id}</h3>
          <div className="muted small">
            {table.columns.length} columns
            {table.isJunction && ' · link table'}
            {table.source && ` · ${table.source}`}
          </div>
        </div>
        <button className="ghost icon-btn" onClick={onClose} aria-label="Close table details">
          ×
        </button>
      </header>
      <div className="erd-details__body">
        {table.comment && <p className="muted small">{table.comment}</p>}
        {outgoing.length > 0 && (
          <div className="erd-details__rels">
            <span className="muted small">References</span>
            {outgoing.map((r) => chip(r.to, `${r.to} (${r.fromColumns.join(', ')})`, r.id))}
          </div>
        )}
        {incoming.length > 0 && (
          <div className="erd-details__rels">
            <span className="muted small">Referenced by</span>
            {incoming.map((r) => chip(r.from, `${r.from} (${r.fromColumns.join(', ')})`, r.id))}
          </div>
        )}
        <ul className="col-list">
          {table.columns.map((c) => {
            const ref = refByCol.get(c.name.toLowerCase())
            return (
              <li key={c.name}>
                <div className="col-list__top">
                  <span className={`mono${c.primaryKey ? ' strong' : ''}`}>{c.name}</span>
                  {c.primaryKey && <span className="key key--pk">PK</span>}
                  {ref && <span className="key key--fk">FK</span>}
                  {c.unique && !c.primaryKey && <span className="key key--uq">UQ</span>}
                  <span className="col-list__type mono">{c.type}</span>
                </div>
                <div className="col-list__meta">
                  <span>{c.nullable ? 'nullable' : 'not null'}</span>
                  {c.autoIncrement && <span>auto increment</span>}
                  {c.defaultValue && (
                    <span>
                      default <span className="mono">{c.defaultValue}</span>
                    </span>
                  )}
                  {ref && <span className="mono">→ {ref}</span>}
                </div>
                {c.comment && <div className="col-list__comment">{c.comment}</div>}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

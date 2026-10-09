import { useMemo, useState } from 'react'
import type { Schema } from '../sql/types'
import { downloadText } from '../util/download'

function refsByTable(schema: Schema) {
  const map = new Map<string, Map<string, string>>()
  for (const r of schema.relationships) {
    const m = map.get(r.from) ?? new Map<string, string>()
    r.fromColumns.forEach((c, i) => m.set(c.toLowerCase(), `${r.to}.${r.toColumns[i] ?? r.toColumns[0] ?? ''}`))
    map.set(r.from, m)
  }
  return map
}

function toMarkdown(schema: Schema) {
  const refs = refsByTable(schema)
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const out = ['# Data dictionary', '']
  for (const t of schema.tables) {
    out.push(`## ${t.id}`, '')
    if (t.comment) out.push(t.comment, '')
    if (t.source) out.push(`_Source: ${t.source}_`, '')
    out.push('| Column | Type | Key | Null | Default | References | Comment |', '|---|---|---|---|---|---|---|')
    for (const c of t.columns) {
      const ref = refs.get(t.id)?.get(c.name.toLowerCase())
      const key = [c.primaryKey && 'PK', ref && 'FK', c.unique && !c.primaryKey && 'UQ'].filter(Boolean).join(', ')
      out.push(
        `| ${esc(c.name)} | ${esc(c.type)} | ${key} | ${c.nullable ? 'YES' : 'NO'} | ${esc(c.defaultValue ?? '')}${c.autoIncrement ? ' (auto)' : ''} | ${ref ?? ''} | ${esc(c.comment ?? '')} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}

export default function DataDictionary({ schema, fileName, multiFile }: { schema: Schema; fileName: string; multiFile: boolean }) {
  const [filter, setFilter] = useState('')
  const refs = useMemo(() => refsByTable(schema), [schema])
  const f = filter.trim().toLowerCase()
  const tables = schema.tables.filter(
    (t) => !f || t.id.toLowerCase().includes(f) || t.columns.some((c) => c.name.toLowerCase().includes(f)),
  )

  return (
    <div className="doc-view">
      <div className="view-toolbar">
        <input
          type="search"
          placeholder="Filter tables or columns…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter tables or columns"
        />
        <div className="view-actions">
          <button onClick={() => downloadText(toMarkdown(schema), `${fileName}-dictionary.md`, 'text/markdown')}>
            Export Markdown
          </button>
        </div>
      </div>
      {tables.length === 0 && <p className="muted">Nothing matches “{filter}”.</p>}
      {tables.map((t) => {
        const tRefs = refs.get(t.id)
        return (
          <section key={t.id} className="dict-table">
            <h2>
              <span className="mono">{t.id}</span>
              {t.isJunction && <span className="pill pill--soft">link table</span>}
              <span className="count">{t.columns.length} columns</span>
              {multiFile && t.source && <span className="muted small source">{t.source}</span>}
            </h2>
            {t.comment && <p className="muted">{t.comment}</p>}
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Key</th>
                    <th>Nullable</th>
                    <th>Default</th>
                    <th>References</th>
                    <th>Comment</th>
                  </tr>
                </thead>
                <tbody>
                  {t.columns.map((c, i) => {
                    const ref = tRefs?.get(c.name.toLowerCase())
                    const hit = f && c.name.toLowerCase().includes(f)
                    return (
                      <tr key={c.name} className={hit ? 'is-hit' : ''}>
                        <td className="num muted">{i + 1}</td>
                        <td className={`mono${c.primaryKey ? ' strong' : ''}`}>{c.name}</td>
                        <td className="mono">{c.type}</td>
                        <td>
                          {c.primaryKey && <span className="key key--pk">PK</span>}
                          {ref && <span className="key key--fk">FK</span>}
                          {c.unique && !c.primaryKey && <span className="key key--uq">UQ</span>}
                          {c.autoIncrement && <span className="key key--ai">AUTO</span>}
                        </td>
                        <td>{c.nullable ? 'Yes' : 'No'}</td>
                        <td className="mono">{c.defaultValue ?? ''}</td>
                        <td className="mono">{ref ?? ''}</td>
                        <td>{c.comment ?? ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </div>
  )
}

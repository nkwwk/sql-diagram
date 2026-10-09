import type { Schema } from '../sql/types'

function cardinalityText(card: string, optional: boolean) {
  const parent = optional ? 'zero or one' : 'exactly one'
  return card === 'one-to-one' ? `Each row has ${parent} parent; parent has at most one` : `Each row has ${parent} parent; parent has many`
}

export default function RelationshipsView({ schema }: { schema: Schema }) {
  const refCount = new Map<string, { out: number; in: number }>()
  for (const t of schema.tables) refCount.set(t.id, { out: 0, in: 0 })
  for (const r of schema.relationships) {
    refCount.get(r.from)!.out++
    refCount.get(r.to)!.in++
  }
  const isolated = schema.tables.filter((t) => {
    const c = refCount.get(t.id)!
    return c.in === 0 && c.out === 0
  })

  return (
    <div className="doc-view">
      <section>
        <h2>Foreign key relationships <span className="count">{schema.relationships.length}</span></h2>
        {schema.relationships.length === 0 ? (
          <p className="muted">No foreign keys were found in this file.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Child table</th>
                  <th>Column(s)</th>
                  <th />
                  <th>Parent table</th>
                  <th>Column(s)</th>
                  <th>Type</th>
                  <th>On delete</th>
                  <th>On update</th>
                  <th>Constraint</th>
                </tr>
              </thead>
              <tbody>
                {schema.relationships.map((r) => (
                  <tr key={r.id}>
                    <td className="mono strong">{r.from}</td>
                    <td className="mono">{r.fromColumns.join(', ')}</td>
                    <td className="arrow">→</td>
                    <td className="mono strong">{r.to}</td>
                    <td className="mono">{r.toColumns.join(', ')}</td>
                    <td title={cardinalityText(r.cardinality, r.optional)}>
                      <span className={`pill ${r.cardinality === 'one-to-one' ? 'pill--one' : 'pill--many'}`}>
                        {r.cardinality === 'one-to-one' ? '1 : 1' : 'N : 1'}
                      </span>
                      {r.optional && <span className="pill pill--soft">optional</span>}
                      {r.identifying && <span className="pill pill--soft">identifying</span>}
                      {r.from === r.to && <span className="pill pill--soft">self</span>}
                    </td>
                    <td className="mono">{r.onDelete ?? '—'}</td>
                    <td className="mono">{r.onUpdate ?? '—'}</td>
                    <td className="mono muted">{r.name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Many-to-many (via link tables) <span className="count">{schema.manyToMany.length}</span></h2>
        {schema.manyToMany.length === 0 ? (
          <p className="muted">No link tables detected. A link table has a composite primary key made of foreign keys to two tables.</p>
        ) : (
          <ul className="m2m">
            {schema.manyToMany.map((m) => (
              <li key={m.via}>
                <span className="mono strong">{m.a}</span>
                <span className="pill pill--many">N : M</span>
                <span className="mono strong">{m.b}</span>
                <span className="muted">via</span>
                <span className="mono">{m.via}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Table connectivity</h2>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Table</th>
                <th className="num">References (out)</th>
                <th className="num">Referenced by (in)</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {[...schema.tables]
                .sort((a, b) => refCount.get(b.id)!.in - refCount.get(a.id)!.in || a.id.localeCompare(b.id))
                .map((t) => {
                  const c = refCount.get(t.id)!
                  const role = t.isJunction
                    ? 'Link table'
                    : c.in === 0 && c.out === 0
                      ? 'Isolated'
                      : c.out === 0
                        ? 'Root / lookup'
                        : c.in === 0
                          ? 'Leaf'
                          : 'Intermediate'
                  return (
                    <tr key={t.id}>
                      <td className="mono strong">{t.id}</td>
                      <td className="num">{c.out}</td>
                      <td className="num">{c.in}</td>
                      <td>{role}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
        {isolated.length > 0 && (
          <p className="muted small">
            {isolated.length} table{isolated.length === 1 ? ' has' : 's have'} no foreign keys in or out.
          </p>
        )}
      </section>
    </div>
  )
}

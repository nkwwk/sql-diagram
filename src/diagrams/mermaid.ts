import type { Relationship, Schema, Table } from '../sql/types'

function safeId(name: string) {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(id) ? id : `_${id}`
}

function quote(label: string) {
  return label.replace(/"/g, '#quot;')
}

function fkColumns(schema: Schema, table: Table): Set<string> {
  const set = new Set<string>()
  for (const r of schema.relationships) {
    if (r.from === table.id) r.fromColumns.forEach((c) => set.add(c.toLowerCase()))
  }
  return set
}

function idMap(schema: Schema) {
  const ids = new Map<string, string>()
  const used = new Set<string>()
  for (const t of schema.tables) {
    let id = safeId(t.id)
    while (used.has(id.toLowerCase())) id += '_'
    used.add(id.toLowerCase())
    ids.set(t.id, id)
  }
  return ids
}

function relLabel(r: Relationship) {
  return r.fromColumns.join(', ')
}

/** Crow's foot entity–relationship diagram. */
export function toMermaidEr(schema: Schema): string {
  const ids = idMap(schema)
  const lines = ['erDiagram']
  for (const t of schema.tables) {
    const id = ids.get(t.id)!
    const fks = fkColumns(schema, t)
    lines.push(`  ${id}${id === t.id ? '' : `["${quote(t.id)}"]`} {`)
    for (const c of t.columns) {
      const type = (c.type || 'unknown').replace(/\s+/g, '_').replace(/,/g, '_').replace(/[^\w\-()[\]]/g, '') || 'unknown'
      const keys = [c.primaryKey && 'PK', fks.has(c.name.toLowerCase()) && 'FK', c.unique && !c.primaryKey && 'UK'].filter(Boolean)
      const comment = c.comment ? ` "${c.comment.replace(/"/g, "'")}"` : ''
      lines.push(`    ${type} ${safeId(c.name)}${keys.length ? ' ' + keys.join(', ') : ''}${comment}`)
    }
    lines.push('  }')
  }
  for (const r of schema.relationships) {
    const child = r.cardinality === 'one-to-one' ? '|o' : '}o'
    const parent = r.optional ? 'o|' : '||'
    const line = r.identifying ? '--' : '..'
    lines.push(`  ${ids.get(r.from)} ${child}${line}${parent} ${ids.get(r.to)} : "${quote(relLabel(r))}"`)
  }
  return lines.join('\n')
}

/** UML class diagram: tables as classes, columns as attributes, FKs as associations. */
export function toMermaidClass(schema: Schema): string {
  const ids = idMap(schema)
  const lines = ['classDiagram', '  direction LR']
  for (const t of schema.tables) {
    const id = ids.get(t.id)!
    const fks = fkColumns(schema, t)
    lines.push(`  class ${id}["${quote(t.id)}"] {`)
    if (t.isJunction) lines.push('    <<link table>>')
    for (const c of t.columns) {
      const type = (c.type || 'unknown').replace(/\(/g, '[').replace(/\)/g, ']').replace(/[{}~]/g, '')
      const keys = [c.primaryKey && 'PK', fks.has(c.name.toLowerCase()) && 'FK', c.unique && !c.primaryKey && 'UQ']
        .filter(Boolean)
        .join(', ')
      const vis = c.primaryKey ? '+' : fks.has(c.name.toLowerCase()) ? '#' : '-'
      lines.push(`    ${vis}${c.name.replace(/[{}()~]/g, '')} : ${type}${c.nullable ? '?' : ''}${keys ? ` [${keys}]` : ''}`)
    }
    lines.push('  }')
  }
  for (const r of schema.relationships) {
    const many = r.cardinality === 'one-to-one' ? (r.optional ? '0..1' : '1') : '*'
    const one = r.optional ? '0..1' : '1'
    const arrow = r.identifying ? '*--' : '-->'
    if (r.identifying) {
      lines.push(`  ${ids.get(r.to)} "${one}" ${arrow} "${many}" ${ids.get(r.from)} : ${relLabel(r)}`)
    } else {
      lines.push(`  ${ids.get(r.from)} "${many}" ${arrow} "${one}" ${ids.get(r.to)} : ${relLabel(r)}`)
    }
  }
  return lines.join('\n')
}

/** Table-level dependency graph: which table references which. */
export function toMermaidGraph(schema: Schema, direction: 'LR' | 'TB' = 'LR'): string {
  const ids = new Map(schema.tables.map((t, i) => [t.id, `t${i}`]))
  const lines = [`flowchart ${direction}`]
  for (const t of schema.tables) {
    const id = ids.get(t.id)!
    const label = `${quote(t.id)}<br/><small>${t.columns.length} column${t.columns.length === 1 ? '' : 's'}</small>`
    lines.push(t.isJunction ? `  ${id}{{"${label}"}}` : `  ${id}["${label}"]`)
  }
  for (const r of schema.relationships) {
    const card = r.cardinality === 'one-to-one' ? '1:1' : 'N:1'
    const arrow = r.optional ? '-.->' : '-->'
    lines.push(`  ${ids.get(r.from)} ${arrow}|"${quote(relLabel(r))} (${card})"| ${ids.get(r.to)}`)
  }
  const roots = schema.tables.filter((t) => !schema.relationships.some((r) => r.from === t.id && r.to !== t.id))
  const junctions = schema.tables.filter((t) => t.isJunction)
  lines.push('  classDef root stroke-width:2px')
  lines.push('  classDef junction stroke-dasharray:4 3')
  if (roots.length) lines.push(`  class ${roots.map((t) => ids.get(t.id)).join(',')} root`)
  if (junctions.length) lines.push(`  class ${junctions.map((t) => ids.get(t.id)).join(',')} junction`)
  return lines.join('\n')
}

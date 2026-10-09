import { StatementScanner } from './scanner'
import type { Column, ManyToMany, Relationship, Schema, Table } from './types'

/*
 * A tolerant DDL parser. It only understands the statements that describe
 * structure (CREATE TABLE, ALTER TABLE, CREATE UNIQUE INDEX, COMMENT ON);
 * the streaming scanner (./scanner.ts) has already dropped comments and
 * everything else, so whole database dumps can be imported.
 * Supports MySQL/MariaDB, PostgreSQL, SQL Server and SQLite syntax.
 */

const DEFAULT_SCHEMAS = new Set(['public', 'dbo', 'main'])

interface RawForeignKey {
  name?: string
  columns: string[]
  refTable: string[]
  refColumns: string[]
  onDelete?: string
  onUpdate?: string
}

interface WorkingTable extends Table {
  foreignKeys: RawForeignKey[]
}

// ---------------------------------------------------------------------------
// Lexing helpers

function skipQuoted(s: string, i: number): number {
  const open = s[i]
  const close = open === '[' ? ']' : open
  let j = i + 1
  while (j < s.length) {
    const c = s[j]
    if (open === "'" && c === '\\') {
      j += 2
      continue
    }
    if (c === close) {
      if (s[j + 1] === close) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return s.length
}

function isQuoteStart(c: string) {
  return c === "'" || c === '"' || c === '`' || c === '['
}

function findClose(s: string, i: number): number {
  let depth = 0
  let j = i
  while (j < s.length) {
    const c = s[j]
    if (isQuoteStart(c) && c !== '[') {
      j = skipQuoted(s, j)
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return j
    }
    j++
  }
  return s.length - 1
}

/** Split on a separator that is not nested in parentheses or quotes. */
export function splitTopLevel(s: string, sep = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (isQuoteStart(c) && c !== '[') {
      i = skipQuoted(s, i)
      continue
    }
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i).trim())
      start = i + 1
    }
    i++
  }
  const last = s.slice(start).trim()
  if (last) parts.push(last)
  return parts
}

interface Tok {
  kind: 'word' | 'str' | 'group' | 'comma'
  text: string
  upper: string
  /** No whitespace between this token and the previous one. */
  joined: boolean
}

function tokenize(s: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let space = true
  const push = (kind: Tok['kind'], text: string) => {
    toks.push({ kind, text, upper: text.toUpperCase(), joined: !space })
    space = false
  }
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      space = true
      i++
    } else if (c === "'") {
      const end = skipQuoted(s, i)
      push('str', s.slice(i, end))
      i = end
    } else if (c === '(') {
      const end = findClose(s, i)
      push('group', s.slice(i, end + 1))
      i = end + 1
    } else if (c === ',') {
      push('comma', c)
      i++
    } else if (c === ')') {
      i++
    } else {
      const start = i
      while (i < s.length && !/[\s(),']/.test(s[i])) {
        i = isQuoteStart(s[i]) && s[i] !== "'" ? skipQuoted(s, i) : i + 1
      }
      push('word', s.slice(start, i))
    }
  }
  return toks
}

function unquoteIdent(p: string): string {
  const c = p[0]
  if (c === '"' || c === '`') return p.slice(1, -1).replaceAll(c + c, c)
  if (c === '[') return p.slice(1, -1).replaceAll(']]', ']')
  return p
}

/** Split a possibly qualified, possibly quoted identifier into its parts. */
function identParts(raw: string): string[] {
  const parts: string[] = []
  let i = 0
  let cur = ''
  while (i < raw.length) {
    const c = raw[i]
    if (c === '"' || c === '`' || c === '[') {
      const end = skipQuoted(raw, i)
      cur += unquoteIdent(raw.slice(i, end))
      i = end
    } else if (c === '.') {
      parts.push(cur)
      cur = ''
      i++
    } else {
      cur += c
      i++
    }
  }
  parts.push(cur)
  return parts.filter((p) => p !== '')
}

function identName(raw: string): string {
  const parts = identParts(raw)
  return parts[parts.length - 1] ?? raw
}

function unquoteString(s: string): string {
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replaceAll("''", "'").replace(/\\(.)/g, '$1')
  }
  return s
}

function groupColumns(group: string): string[] {
  return splitTopLevel(group.slice(1, -1))
    .map((item) => tokenize(item)[0])
    .filter((t): t is Tok => !!t && t.kind === 'word')
    .map((t) => identName(t.text))
}

// ---------------------------------------------------------------------------
// Parsing

const COLUMN_STOP = new Set([
  'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'DEFAULT', 'REFERENCES', 'CHECK', 'CONSTRAINT',
  'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'COMMENT', 'COLLATE', 'CHARSET',
  'GENERATED', 'AS', 'ON', 'ENCODE', 'SPARSE', 'ROWGUIDCOL', 'STORED', 'VIRTUAL',
  'INVISIBLE', 'VISIBLE', 'SRID', 'KEY', 'FOREIGN',
])

const REF_ACTIONS = ['SET NULL', 'SET DEFAULT', 'NO ACTION', 'CASCADE', 'RESTRICT']

function parseReferences(toks: Tok[], j: number): { fk: Omit<RawForeignKey, 'columns'>; next: number } {
  // toks[j] is REFERENCES
  let k = j + 1
  const refTable = toks[k] ? identParts(toks[k].text) : []
  k++
  let refColumns: string[] = []
  if (toks[k]?.kind === 'group') {
    refColumns = groupColumns(toks[k].text)
    k++
  }
  const fk: Omit<RawForeignKey, 'columns'> = { refTable, refColumns }
  while (k < toks.length) {
    if (toks[k].upper === 'MATCH') {
      k += 2
      continue
    }
    if (toks[k].upper !== 'ON' || !toks[k + 1]) break
    const which = toks[k + 1].upper
    const rest = toks.slice(k + 2, k + 4).map((t) => t.upper)
    const action = REF_ACTIONS.find((a) => rest.join(' ').startsWith(a))
    if (!action || (which !== 'DELETE' && which !== 'UPDATE')) break
    if (which === 'DELETE') fk.onDelete = action
    else fk.onUpdate = action
    k += 2 + action.split(' ').length
  }
  return { fk, next: k }
}

function parseColumn(toks: Tok[], fks: RawForeignKey[]): Column | null {
  if (toks[0]?.kind !== 'word') return null
  const name = identName(toks[0].text)
  let j = 1
  let type = ''
  while (j < toks.length) {
    const t = toks[j]
    if (t.kind === 'comma') break
    if (COLUMN_STOP.has(t.upper)) break
    if (t.upper === 'CHARACTER' && toks[j + 1]?.upper === 'SET') break
    type += (t.joined || !type ? '' : ' ') + t.text
    j++
  }
  const col: Column = {
    name,
    type: type.replace(/\[([A-Za-z_]\w*)\]/g, '$1').replace(/\s+/g, ' '),
    nullable: true,
    primaryKey: false,
    unique: false,
    autoIncrement: /^(small|big)?serial\d?$/i.test(type),
  }
  for (; j < toks.length; j++) {
    const u = toks[j].upper
    switch (u) {
      case 'NOT':
        if (toks[j + 1]?.upper === 'NULL') {
          col.nullable = false
          j++
        }
        break
      case 'NULL':
        col.nullable = true
        break
      case 'PRIMARY':
        col.primaryKey = true
        col.nullable = false
        if (toks[j + 1]?.upper === 'KEY') j++
        break
      case 'UNIQUE':
        col.unique = true
        if (toks[j + 1]?.upper === 'KEY') j++
        break
      case 'DEFAULT': {
        const next = toks[j + 1]
        if (!next) break
        let value = next.text
        j++
        while (toks[j + 1]?.joined && toks[j + 1].kind !== 'comma') {
          value += toks[j + 1].text
          j++
        }
        col.defaultValue = value
        if (/nextval\s*\(/i.test(value)) col.autoIncrement = true
        break
      }
      case 'AUTO_INCREMENT':
      case 'AUTOINCREMENT':
      case 'IDENTITY':
        col.autoIncrement = true
        break
      case 'GENERATED':
        if (toks.slice(j, j + 6).some((t) => t.upper === 'IDENTITY')) col.autoIncrement = true
        break
      case 'REFERENCES': {
        const { fk, next } = parseReferences(toks, j)
        fks.push({ ...fk, columns: [name] })
        j = next - 1
        break
      }
      case 'COMMENT':
        if (toks[j + 1]?.kind === 'str') {
          col.comment = unquoteString(toks[j + 1].text)
          j++
        }
        break
      case 'CONSTRAINT':
        j++
        break
    }
  }
  return col
}

/** Parse one item of a CREATE TABLE body (or an ALTER TABLE ... ADD clause). */
function parseTableItem(text: string, table: WorkingTable): Column | null {
  const toks = tokenize(text)
  if (!toks.length) return null
  let i = 0
  let constraintName: string | undefined
  if (toks[0].upper === 'CONSTRAINT') {
    constraintName = toks[1] ? identName(toks[1].text) : undefined
    i = 2
  }
  const kw = toks[i]?.upper
  const firstGroupAfter = (k: number) => toks.slice(k).find((t) => t.kind === 'group')

  if (kw === 'PRIMARY') {
    const g = firstGroupAfter(i)
    if (g) table.primaryKey = groupColumns(g.text)
    return null
  }
  if (kw === 'FOREIGN') {
    const refIdx = toks.findIndex((t, k) => k > i && t.upper === 'REFERENCES')
    const g = toks.slice(i, refIdx < 0 ? undefined : refIdx).find((t) => t.kind === 'group')
    if (g && refIdx >= 0) {
      const { fk } = parseReferences(toks, refIdx)
      table.foreignKeys.push({ ...fk, name: constraintName, columns: groupColumns(g.text) })
    }
    return null
  }
  if (kw === 'UNIQUE') {
    const g = firstGroupAfter(i)
    if (g) table.uniques.push(groupColumns(g.text))
    return null
  }
  if (
    constraintName !== undefined ||
    ['KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'CHECK', 'EXCLUDE', 'PERIOD', 'LIKE', 'DEFAULT'].includes(kw ?? '')
  ) {
    return null
  }
  const fks: RawForeignKey[] = []
  const col = parseColumn(toks, fks)
  for (const fk of fks) table.foreignKeys.push(fk)
  return col
}

function newTable(parts: string[]): WorkingTable {
  const name = parts[parts.length - 1]
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined
  const id = schema && !DEFAULT_SCHEMAS.has(schema.toLowerCase()) ? `${schema}.${name}` : name
  return { id, name, schema, columns: [], primaryKey: [], uniques: [], foreignKeys: [], isJunction: false }
}

/** Registry key: schema-qualified unless the schema is a default one, so `public.users` ≡ `users`. */
function tableKey(parts: string[]): string {
  const name = parts[parts.length - 1]
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined
  return (schema && !DEFAULT_SCHEMAS.has(schema.toLowerCase()) ? `${schema}.${name}` : name).toLowerCase()
}

class TableRegistry {
  tables: WorkingTable[] = []
  private byKey = new Map<string, WorkingTable>()
  private byName = new Map<string, WorkingTable>()

  add(t: WorkingTable, warnings: string[]) {
    const key = t.id.toLowerCase()
    const existing = this.byKey.get(key)
    if (existing) {
      this.tables = this.tables.filter((x) => x !== existing)
      const where = existing.source && t.source && existing.source !== t.source ? ` (${existing.source} and ${t.source})` : ''
      warnings.push(`Table "${t.id}" is defined more than once${where}; the last definition is used.`)
    }
    this.tables.push(t)
    this.byKey.set(key, t)
    if (!this.byName.has(t.name.toLowerCase()) || existing) this.byName.set(t.name.toLowerCase(), t)
  }

  find(parts: string[]): WorkingTable | undefined {
    if (!parts.length) return undefined
    return this.byKey.get(tableKey(parts)) ?? this.byName.get(parts[parts.length - 1].toLowerCase())
  }
}

function findColumn(t: Table, name: string): Column | undefined {
  const lower = name.toLowerCase()
  return t.columns.find((c) => c.name.toLowerCase() === lower)
}

function parseCreateTable(stmt: string, reg: TableRegistry, warnings: string[], source?: string) {
  const header = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|VIRTUAL)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(stmt)
  if (!header) return
  const toks = tokenize(stmt.slice(header[0].length))
  if (toks[0]?.kind !== 'word') return
  const parts = identParts(toks[0].text)
  if (toks[1]?.kind !== 'group') {
    warnings.push(`Skipped table "${parts.join('.')}": no column list (CREATE TABLE ... AS / PARTITION OF is not supported).`)
    return
  }
  const table = newTable(parts)
  table.source = source
  for (const item of splitTopLevel(toks[1].text.slice(1, -1))) {
    const col = parseTableItem(item, table)
    if (col) table.columns.push(col)
  }
  const options = toks.slice(2)
  const ci = options.findIndex((t) => t.upper.startsWith('COMMENT'))
  if (ci >= 0) {
    const s = options.slice(ci + 1).find((t) => t.kind === 'str')
    if (s) table.comment = unquoteString(s.text)
  }
  reg.add(table, warnings)
}

function parseAlterTable(stmt: string, reg: TableRegistry, warnings: string[]) {
  const header = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/i.exec(stmt)
  if (!header) return
  const toks = tokenize(stmt.slice(header[0].length))
  if (toks[0]?.kind !== 'word') return
  const parts = identParts(toks[0].text)
  const table = reg.find(parts)
  if (!table) {
    warnings.push(`ALTER TABLE on unknown table "${parts.join('.')}" was ignored.`)
    return
  }
  const rest = stmt
    .slice(header[0].length)
    .trimStart()
    .slice(toks[0].text.length)
    .replace(/^\s*WITH\s+(NO)?CHECK\b/i, '')
  let lastVerb = ''
  for (let action of splitTopLevel(rest)) {
    const verb = /^(ADD|MODIFY|CHANGE|ALTER|DROP|RENAME)\b/i.exec(action)?.[1].toUpperCase()
    if (verb) lastVerb = verb
    else if (lastVerb === 'ADD') action = 'ADD ' + action
    else continue

    if (lastVerb === 'ADD') {
      const item = action.replace(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i, '')
      const col = parseTableItem(item, table)
      if (col && !findColumn(table, col.name)) table.columns.push(col)
    } else if (lastVerb === 'MODIFY' || lastVerb === 'CHANGE') {
      let def = action.replace(/^(MODIFY|CHANGE)\s+(?:COLUMN\s+)?/i, '')
      const defToks = tokenize(def)
      const target = defToks[0] ? identName(defToks[0].text) : ''
      if (lastVerb === 'CHANGE') def = def.slice(defToks[0]?.text.length ?? 0)
      const fks: RawForeignKey[] = []
      const col = parseColumn(tokenize(def), fks)
      const existing = findColumn(table, target)
      if (col && existing) {
        Object.assign(existing, {
          name: col.name,
          type: col.type || existing.type,
          nullable: col.nullable,
          primaryKey: existing.primaryKey || col.primaryKey,
          unique: existing.unique || col.unique,
          autoIncrement: existing.autoIncrement || col.autoIncrement,
          defaultValue: col.defaultValue ?? existing.defaultValue,
          comment: col.comment ?? existing.comment,
        })
      }
      table.foreignKeys.push(...fks)
    } else if (lastVerb === 'ALTER') {
      const m = /^ALTER\s+(?:COLUMN\s+)?(\S+)\s+(.*)$/is.exec(action)
      const existing = m && findColumn(table, identName(m[1]))
      if (!m || !existing) continue
      const op = m[2]
      let mm: RegExpExecArray | null
      if (/^SET\s+NOT\s+NULL/i.test(op)) existing.nullable = false
      else if (/^DROP\s+NOT\s+NULL/i.test(op)) existing.nullable = true
      else if ((mm = /^SET\s+DEFAULT\s+(.*)$/is.exec(op))) {
        existing.defaultValue = mm[1].trim()
        if (/nextval\s*\(/i.test(mm[1])) existing.autoIncrement = true
      } else if (/^ADD\s+GENERATED\b.*IDENTITY/is.test(op)) existing.autoIncrement = true
      else if ((mm = /^(?:SET\s+DATA\s+)?TYPE\s+(.*)$/is.exec(op))) existing.type = mm[1].replace(/\s+USING\s+.*$/is, '').trim()
    }
  }
}

function parseCreateUniqueIndex(stmt: string, reg: TableRegistry) {
  const header = /^CREATE\s+UNIQUE\s+(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:ONLY\s+)?/i.exec(stmt)
  if (!header) return
  const toks = tokenize(stmt.slice(header[0].length))
  const table = toks[0] && reg.find(identParts(toks[0].text))
  const group = toks.find((t) => t.kind === 'group')
  if (table && group) table.uniques.push(groupColumns(group.text))
}

function parseComment(stmt: string, reg: TableRegistry) {
  const header = /^COMMENT\s+ON\s+(TABLE|COLUMN)\s+/i.exec(stmt)
  if (!header) return
  const toks = tokenize(stmt.slice(header[0].length))
  const str = toks.find((t) => t.kind === 'str')
  if (!toks[0] || !str) return
  const parts = identParts(toks[0].text)
  const comment = unquoteString(str.text)
  if (header[1].toUpperCase() === 'TABLE') {
    const t = reg.find(parts)
    if (t) t.comment = comment
  } else {
    const t = reg.find(parts.slice(0, -1))
    const c = t && findColumn(t, parts[parts.length - 1])
    if (c) c.comment = comment
  }
}

// ---------------------------------------------------------------------------
// Assembly

const CREATE_TABLE_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|VIRTUAL)\s+)?TABLE\s/i

interface PendingStatement {
  sql: string
  source?: string
}

/**
 * Collects DDL statements (possibly from several files) and builds the schema.
 * CREATE TABLE statements are applied before everything else, so an ALTER TABLE
 * in one file may refer to a table created in a file imported after it.
 */
export class SchemaBuilder {
  private creates: PendingStatement[] = []
  private others: PendingStatement[] = []

  add(sql: string, source?: string) {
    if (CREATE_TABLE_RE.test(sql)) this.creates.push({ sql, source })
    else this.others.push({ sql, source })
  }

  build(): Schema {
    return buildSchema(this.creates, this.others)
  }
}

/** Parse a complete SQL text (one file). */
export function parseSql(sql: string, source?: string): Schema {
  const builder = new SchemaBuilder()
  const scanner = new StatementScanner((s) => builder.add(s, source))
  scanner.push(sql)
  scanner.end()
  return builder.build()
}

function buildSchema(creates: PendingStatement[], others: PendingStatement[]): Schema {
  const reg = new TableRegistry()
  const warnings: string[] = []

  for (const { sql: stmt, source } of [...creates, ...others]) {
    const head = stmt.slice(0, 80).toUpperCase().replace(/\s+/g, ' ')
    try {
      if (CREATE_TABLE_RE.test(stmt)) {
        parseCreateTable(stmt, reg, warnings, source)
      } else if (head.startsWith('ALTER TABLE ')) {
        parseAlterTable(stmt, reg, warnings)
      } else if (head.startsWith('CREATE UNIQUE ')) {
        parseCreateUniqueIndex(stmt, reg)
      } else if (head.startsWith('COMMENT ON ')) {
        parseComment(stmt, reg)
      }
    } catch (e) {
      warnings.push(`Could not parse statement starting "${stmt.slice(0, 60)}…": ${(e as Error).message}`)
    }
  }

  const tables = reg.tables

  // Normalise keys
  for (const t of tables) {
    if (!t.primaryKey.length) t.primaryKey = t.columns.filter((c) => c.primaryKey).map((c) => c.name)
    for (const name of t.primaryKey) {
      const c = findColumn(t, name)
      if (c) {
        c.primaryKey = true
        c.nullable = false
      }
    }
    for (const c of t.columns) if (c.unique) t.uniques.push([c.name])
    for (const u of t.uniques) {
      if (u.length === 1) {
        const c = findColumn(t, u[0])
        if (c) c.unique = true
      }
    }
  }

  // Resolve foreign keys into relationships
  const relationships: Relationship[] = []
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()))

  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const parent = reg.find(fk.refTable)
      if (!parent) {
        warnings.push(`${t.id}: foreign key references unknown table "${fk.refTable.join('.')}".`)
        continue
      }
      const toColumns = fk.refColumns.length ? fk.refColumns : parent.primaryKey
      const fromCols = fk.columns.map((c) => findColumn(t, c)?.name ?? c)
      const isUnique = sameSet(fromCols, t.primaryKey) || t.uniques.some((u) => sameSet(fromCols, u))
      const optional = fromCols.some((c) => findColumn(t, c)?.nullable ?? true)
      const identifying = fromCols.every((c) => t.primaryKey.some((p) => p.toLowerCase() === c.toLowerCase()))
      const id = `${t.id}(${fromCols.join(',')})->${parent.id}`
      if (relationships.some((r) => r.id === id)) continue
      relationships.push({
        id,
        name: fk.name,
        from: t.id,
        fromColumns: fromCols,
        to: parent.id,
        toColumns: toColumns.map((c) => findColumn(parent, c)?.name ?? c),
        cardinality: isUnique ? 'one-to-one' : 'many-to-one',
        optional,
        identifying,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      })
    }
  }

  // Detect link tables: composite PK made up of foreign keys to two other tables.
  const manyToMany: ManyToMany[] = []
  for (const t of tables) {
    if (t.primaryKey.length < 2) continue
    const pkRels = relationships.filter(
      (r) => r.from === t.id && r.to !== t.id && r.fromColumns.every((c) => t.primaryKey.some((p) => p.toLowerCase() === c.toLowerCase())),
    )
    const parents = [...new Set(pkRels.map((r) => r.to))]
    if (parents.length === 2) {
      t.isJunction = true
      manyToMany.push({ via: t.id, a: parents[0], b: parents[1] })
    }
  }

  return {
    tables: tables.map(({ foreignKeys: _fk, ...rest }) => rest),
    relationships,
    manyToMany,
    warnings,
  }
}

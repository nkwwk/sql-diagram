import { describe, expect, it } from 'vitest'
import { SchemaBuilder, parseSql } from '../src/sql/parser'
import { SAMPLE_SQL } from '../src/sql/sample'
import { importFiles } from '../src/sql/import'
import { scanStatements } from '../src/sql/scanner'
import { toMermaidClass, toMermaidEr, toMermaidGraph } from '../src/diagrams/mermaid'
import { layoutSchema } from '../src/erd/layout'
import type { Schema } from '../src/sql/types'
import { MSSQL_SCRIPT, MYSQL_DUMP, PG_DUMP, SQLITE_DUMP } from './fixtures'

const table = (s: Schema, id: string) => {
  const t = s.tables.find((x) => x.id === id)
  if (!t) throw new Error(`table ${id} not found; have ${s.tables.map((x) => x.id).join(', ')}`)
  return t
}
const col = (s: Schema, tableId: string, name: string) => {
  const c = table(s, tableId).columns.find((x) => x.name === name)
  if (!c) throw new Error(`column ${tableId}.${name} not found`)
  return c
}
const rel = (s: Schema, from: string, to: string) => s.relationships.find((r) => r.from === from && r.to === to)

describe('sample schema', () => {
  const s = parseSql(SAMPLE_SQL)

  it('finds every table and relationship', () => {
    expect(s.tables).toHaveLength(10)
    expect(s.relationships).toHaveLength(12)
    expect(s.warnings).toEqual([])
  })

  it('classifies cardinality, optionality and identifying relationships', () => {
    expect(rel(s, 'user_profiles', 'users')).toMatchObject({ cardinality: 'one-to-one', identifying: true, optional: false })
    expect(rel(s, 'payments', 'orders')).toMatchObject({ cardinality: 'one-to-one', identifying: false })
    expect(rel(s, 'orders', 'addresses')).toMatchObject({ cardinality: 'many-to-one', optional: true, onDelete: 'SET NULL' })
    expect(rel(s, 'categories', 'categories')).toMatchObject({ fromColumns: ['parent_id'], toColumns: ['id'] })
  })

  it('detects link tables as many-to-many', () => {
    expect(s.manyToMany).toEqual([{ via: 'product_categories', a: 'products', b: 'categories' }])
    expect(table(s, 'product_categories').isJunction).toBe(true)
    expect(table(s, 'order_items').isJunction).toBe(false)
  })

  it('reads keys, defaults and comments', () => {
    expect(table(s, 'users').comment).toBe('Registered customers and staff')
    expect(col(s, 'users', 'id')).toMatchObject({ primaryKey: true, autoIncrement: true, nullable: false })
    expect(col(s, 'users', 'email')).toMatchObject({ unique: true, nullable: false })
    expect(col(s, 'users', 'created_at').defaultValue).toBe('now()')
    expect(col(s, 'products', 'sku').comment).toBe('Stock keeping unit')
    expect(col(s, 'products', 'price').type).toBe('NUMERIC(10,2)')
    expect(table(s, 'order_items').primaryKey).toEqual(['order_id', 'line_no'])
  })
})

describe('MySQL dump', () => {
  const s = parseSql(MYSQL_DUMP)

  it('parses tables and skips data, triggers and conditional comments', () => {
    expect(s.tables.map((t) => t.id)).toEqual(['authors', 'books', 'book_tags'])
    expect(s.warnings).toEqual([])
  })

  it('reads MySQL column syntax', () => {
    expect(col(s, 'authors', 'id')).toMatchObject({ type: 'int(11) unsigned', autoIncrement: true, primaryKey: true })
    expect(col(s, 'authors', 'name')).toMatchObject({ type: 'varchar(100)', defaultValue: "''", comment: "Author's name; full" })
    expect(col(s, 'authors', 'status').type).toBe("enum('active','retired')")
    expect(table(s, 'authors').comment).toBe('Book authors')
    expect(col(s, 'books', 'isbn').unique).toBe(true)
    expect(col(s, 'books', 'id').autoIncrement).toBe(true) // from ALTER TABLE … MODIFY
  })

  it('resolves foreign keys with actions', () => {
    expect(rel(s, 'books', 'authors')).toMatchObject({ name: 'fk_author', onDelete: 'SET NULL', onUpdate: 'CASCADE', optional: true })
    expect(rel(s, 'book_tags', 'books')).toMatchObject({ identifying: true, cardinality: 'many-to-one' })
  })
})

describe('PostgreSQL pg_dump', () => {
  const s = parseSql(PG_DUMP)

  it('parses tables across schemas and ignores functions and COPY data', () => {
    expect(s.tables.map((t) => t.id)).toEqual(['customers', 'orders', 'sales.invoices'])
    expect(s.warnings).toEqual([])
  })

  it('applies ALTER TABLE ONLY constraints, defaults, indexes and comments', () => {
    expect(table(s, 'customers').primaryKey).toEqual(['id'])
    expect(col(s, 'customers', 'id').autoIncrement).toBe(true)
    expect(col(s, 'customers', 'email')).toMatchObject({ unique: true, comment: 'Login e-mail', type: 'character varying(255)' })
    expect(col(s, 'customers', 'Display Name').type).toBe('text')
    expect(col(s, 'customers', 'created_at').type).toBe('timestamp without time zone')
    expect(table(s, 'customers').comment).toBe('People who buy things')
  })

  it('resolves schema-qualified foreign keys', () => {
    expect(rel(s, 'orders', 'customers')).toMatchObject({ onDelete: 'SET NULL', optional: true })
    expect(rel(s, 'sales.invoices', 'orders')).toMatchObject({ optional: false })
  })
})

describe('SQL Server script', () => {
  const s = parseSql(MSSQL_SCRIPT)

  it('splits on GO and reads bracketed identifiers and types', () => {
    expect(s.tables.map((t) => t.id)).toEqual(['Customers', 'sales.Orders'])
    expect(col(s, 'Customers', 'CustomerID')).toMatchObject({ type: 'int', autoIncrement: true, primaryKey: true })
    expect(col(s, 'Customers', 'Name').type).toBe('nvarchar(50)')
    expect(col(s, 'sales.Orders', 'Total').type).toBe('decimal(18, 2)')
  })

  it('resolves WITH CHECK ADD CONSTRAINT foreign keys', () => {
    expect(rel(s, 'sales.Orders', 'Customers')).toMatchObject({ name: 'FK_Orders_Customers', fromColumns: ['CustomerID'] })
    expect(s.warnings).toEqual([])
  })
})

describe('SQLite dump', () => {
  const s = parseSql(SQLITE_DUMP)

  it('parses tables, implicit-PK references and self references', () => {
    expect(s.tables.map((t) => t.id)).toEqual(['artists', 'albums'])
    expect(rel(s, 'albums', 'artists')).toMatchObject({ toColumns: ['id'] })
    expect(rel(s, 'albums', 'albums')).toMatchObject({ fromColumns: ['parent_id'] })
    expect(col(s, 'artists', 'id').autoIncrement).toBe(true)
  })
})

describe('multiple files', () => {
  const constraints = `ALTER TABLE orders ADD CONSTRAINT fk_o_c FOREIGN KEY (customer_id) REFERENCES customers (id);`
  const customers = `CREATE TABLE customers (id INT PRIMARY KEY, name TEXT);`
  const orders = `CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT NOT NULL);`

  it('merges files regardless of order (constraints file first)', () => {
    const b = new SchemaBuilder()
    for (const [name, sql] of [['constraints.sql', constraints], ['customers.sql', customers], ['orders.sql', orders]]) {
      parseInto(b, sql, name)
    }
    const s = b.build()
    expect(s.tables.map((t) => t.id).sort()).toEqual(['customers', 'orders'])
    expect(rel(s, 'orders', 'customers')).toMatchObject({ name: 'fk_o_c' })
    expect(table(s, 'orders').source).toBe('orders.sql')
    expect(s.warnings).toEqual([])
  })

  it('imports Files end to end and reports per-file statistics', async () => {
    const files = [
      new File([constraints], 'constraints.sql'),
      new File([customers + "\nINSERT INTO customers VALUES (1, 'a;b');"], 'customers.sql'),
      new File([orders], 'orders.sql'),
    ]
    const progress: number[] = []
    const result = await importFiles(files, (p) => progress.push(p.fileIndex))
    expect(result.schema.relationships).toHaveLength(1)
    expect(result.files.map((f) => [f.name, f.tables, f.inserts])).toEqual([
      ['constraints.sql', 0, 0],
      ['customers.sql', 1, 1],
      ['orders.sql', 1, 0],
    ])
    expect(progress).toEqual([0, 1, 2])
    // The retained DDL re-imports to the same schema.
    const again = await importFiles(result.ddl.map((d, i) => new File([d], result.files[i].name)))
    expect(again.schema).toEqual(result.schema)
  })

  it('warns when the same table is defined in two files', () => {
    const b = new SchemaBuilder()
    parseInto(b, customers, 'a.sql')
    parseInto(b, customers.replace('name TEXT', 'name TEXT, extra INT'), 'b.sql')
    const s = b.build()
    expect(s.tables).toHaveLength(1)
    expect(parseSql('CREATE TABLE users (id int);\nCREATE TABLE public.users (id int, x int);').tables).toHaveLength(1)
    expect(table(s, 'customers').columns).toHaveLength(3)
    expect(s.warnings[0]).toMatch(/defined more than once \(a\.sql and b\.sql\)/)
  })
})

describe('diagram generators', () => {
  // Rename pg's orders so it doesn't collide with the sample's orders table.
  const s = parseSql(SAMPLE_SQL + PG_DUMP.replaceAll('public.orders', 'public.purchases'))

  it('produces Mermaid ER with crow-foot cardinalities and sanitised ids', () => {
    const er = toMermaidEr(s)
    expect(er.startsWith('erDiagram')).toBe(true)
    expect(er).toContain('user_profiles |o--|| users : "user_id"')
    expect(er).toContain('orders }o..o| addresses : "shipping_address_id"')
    expect(er).toContain('sales_invoices["sales.invoices"] {')
    expect(er).toMatch(/text Display_Name\b/)
  })

  it('produces UML class and dependency graph diagrams', () => {
    const cls = toMermaidClass(s)
    expect(cls).toContain('class product_categories["product_categories"] {')
    expect(cls).toContain('<<link table>>')
    expect(cls).not.toMatch(/: NUMERIC\(/) // parentheses would turn attributes into methods
    const graph = toMermaidGraph(s, 'TB')
    expect(graph.startsWith('flowchart TB')).toBe(true)
    expect(graph.match(/-->|-\.->/g)).toHaveLength(s.relationships.length)
  })

  it('lays out every table at a finite, non-overlapping position', () => {
    const nodes = layoutSchema(s, 'LR')
    expect(nodes).toHaveLength(s.tables.length)
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x) && Number.isFinite(n.position.y)).toBe(true)
    }
    const ids = new Set(nodes.map((n) => `${Math.round(n.position.x)},${Math.round(n.position.y)}`))
    expect(ids.size).toBe(nodes.length)
  })
})

/** Same path the importer uses: scanner → builder. */
function parseInto(builder: SchemaBuilder, sql: string, source: string) {
  for (const stmt of scanStatements(sql).statements) builder.add(stmt, source)
}

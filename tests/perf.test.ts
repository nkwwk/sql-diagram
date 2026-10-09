import { describe, expect, it } from 'vitest'
import { parseSql } from '../src/sql/parser'
import { scanStatements } from '../src/sql/scanner'
import { importFiles } from '../src/sql/import'
import { layoutSchema } from '../src/erd/layout'

/*
 * Performance budgets are deliberately generous so they hold on slow CI
 * runners; they exist to catch accidental O(n²) behaviour, which would blow
 * past them by orders of magnitude.
 */
const PERF_SCALE = Number(process.env.PERF_SCALE ?? 1)
const MB = 1024 * 1024

function time<T>(fn: () => T): [T, number] {
  const t = performance.now()
  const r = fn()
  return [r, performance.now() - t]
}

function report(label: string, chars: number, ms: number) {
  console.log(`[perf] ${label}: ${(chars / MB).toFixed(1)} MB in ${ms.toFixed(0)} ms (${(chars / MB / (ms / 1000)).toFixed(0)} MB/s)`)
}

const SCHEMA = Array.from(
  { length: 20 },
  (_, i) => `CREATE TABLE \`t${i}\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`parent_id\` int DEFAULT NULL,
  \`name\` varchar(200) NOT NULL DEFAULT '',
  \`payload\` text,
  PRIMARY KEY (\`id\`)${i > 0 ? `,\n  CONSTRAINT \`fk_t${i}\` FOREIGN KEY (\`parent_id\`) REFERENCES \`t${i - 1}\` (\`id\`)` : ''}
) ENGINE=InnoDB;`,
).join('\n\n')

/** A mysqldump-like file: the schema, then extended INSERTs with nasty string content. */
function mysqlDump(targetBytes: number) {
  const parts = [SCHEMA]
  const row = (n: number) =>
    `(${n},${n - 1},'name ${n}; DROP TABLE x; -- \\'quoted\\' /* not */','{"json":"va\\\\lue;","n":${n}}')`
  let size = SCHEMA.length
  let n = 0
  while (size < targetBytes) {
    const rows: string[] = []
    for (let r = 0; r < 200; r++) rows.push(row(++n))
    const stmt = `INSERT INTO \`t${n % 20}\` VALUES ${rows.join(',')};\n`
    parts.push(stmt)
    size += stmt.length
  }
  parts.push('CREATE TABLE `last_table` (`id` int PRIMARY KEY, `t0_id` int REFERENCES `t0`(`id`));')
  return parts.join('\n')
}

function pgCopyDump(targetBytes: number) {
  const parts = ['SET standard_conforming_strings = on;', SCHEMA.replace(/`/g, '"').replace(/ ENGINE=InnoDB| AUTO_INCREMENT/g, '')]
  let size = 0
  let n = 0
  while (size < targetBytes) {
    const lines = [`COPY public.t${n % 20} (id, parent_id, name, payload) FROM stdin;`]
    for (let r = 0; r < 2000; r++) lines.push(`${++n}\t${n - 1}\tname; 'x' "y" -- z\t{"a": "b;c"}`)
    lines.push('\\.\n')
    const block = lines.join('\n')
    parts.push(block)
    size += block.length
  }
  parts.push('CREATE TABLE last_table (id int PRIMARY KEY);')
  return parts.join('\n')
}

describe('performance', () => {
  it('scans a large MySQL dump with extended INSERTs quickly', () => {
    const sql = mysqlDump(40 * MB * PERF_SCALE)
    const [s, ms] = time(() => parseSql(sql))
    report('mysqldump INSERTs', sql.length, ms)
    expect(s.tables).toHaveLength(21)
    expect(s.relationships).toHaveLength(20)
    expect(ms).toBeLessThan(15_000 * PERF_SCALE)
  })

  it('scans a large pg_dump with COPY blocks quickly', () => {
    const sql = pgCopyDump(40 * MB * PERF_SCALE)
    const [{ statements, stats }, ms] = time(() => scanStatements(sql))
    report('pg_dump COPY', sql.length, ms)
    expect(statements.filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(21)
    expect(stats.copyBlocks).toBeGreaterThan(100)
    expect(ms).toBeLessThan(10_000 * PERF_SCALE)
  })

  it('streams files in chunks and retains only DDL', async () => {
    const sql = mysqlDump(24 * MB * PERF_SCALE)
    const file = new File([sql], 'big.sql')
    const t = performance.now()
    let progressCalls = 0
    const result = await importFiles([file], () => progressCalls++)
    const ms = performance.now() - t
    report('importFiles stream', sql.length, ms)
    expect(result.schema.tables).toHaveLength(21)
    expect(result.files[0].inserts).toBeGreaterThan(1000)
    expect(progressCalls).toBeGreaterThanOrEqual(1)
    // Retained text is the DDL only — a tiny fraction of the input.
    expect(result.ddl[0].length).toBeLessThan(20_000)
    expect(ms).toBeLessThan(20_000 * PERF_SCALE)
  })

  it('handles a single huge string literal linearly', () => {
    const sql = `INSERT INTO t VALUES ('${'x'.repeat(30 * MB)}');\nCREATE TABLE after (id int);`
    const [s, ms] = time(() => parseSql(sql))
    report('one 30 MB literal', sql.length, ms)
    expect(s.tables.map((t) => t.id)).toEqual(['after'])
    expect(ms).toBeLessThan(5_000)
  })

  it('stays linear with many short strings and a distant backslash', () => {
    // Without caching the next-backslash position this is quadratic.
    const sql = `INSERT INTO t VALUES ${Array.from({ length: 400_000 }, () => "('a')").join(',')}, ('\\\\');\nCREATE TABLE after (id int);`
    const [s, ms] = time(() => parseSql(sql))
    report('400k short strings', sql.length, ms)
    expect(s.tables.map((t) => t.id)).toEqual(['after'])
    expect(ms).toBeLessThan(5_000)
  })

  it('parses a schema with thousands of tables and foreign keys', () => {
    const count = 3000
    const sql = Array.from(
      { length: count },
      (_, i) =>
        `CREATE TABLE t${i} (id bigint PRIMARY KEY, name text NOT NULL, created_at timestamp DEFAULT now()${
          i > 0 ? `, a_id bigint REFERENCES t${Math.floor(i / 2)}(id), b_id bigint REFERENCES t${i - 1}(id)` : ''
        });`,
    ).join('\n')
    const [s, ms] = time(() => parseSql(sql))
    report(`${count} tables`, sql.length, ms)
    expect(s.tables).toHaveLength(count)
    expect(s.relationships).toHaveLength((count - 1) * 2)
    expect(ms).toBeLessThan(5_000)
  })

  it('lays out a large schema in reasonable time', () => {
    const count = 400
    const sql = Array.from(
      { length: count },
      (_, i) => `CREATE TABLE t${i} (id int PRIMARY KEY, p int${i > 0 ? ` REFERENCES t${Math.floor(i / 3)}(id)` : ''}, x text);`,
    ).join('\n')
    const s = parseSql(sql)
    const [nodes, ms] = time(() => layoutSchema(s, 'LR'))
    console.log(`[perf] dagre layout of ${count} tables: ${ms.toFixed(0)} ms`)
    expect(nodes).toHaveLength(count)
    expect(ms).toBeLessThan(15_000)
  })
})

import { describe, expect, it } from 'vitest'
import { parseSql } from '../src/sql/parser'
import { StatementScanner, scanStatements } from '../src/sql/scanner'
import { importFiles } from '../src/sql/import'
import { MSSQL_SCRIPT, MYSQL_DUMP, PG_DUMP, SQLITE_DUMP } from './fixtures'

const ids = (sql: string) => parseSql(sql).tables.map((t) => t.id)

function scanChunked(sql: string, size: number) {
  const out: string[] = []
  const scanner = new StatementScanner((s) => out.push(s))
  for (let i = 0; i < sql.length; i += size) scanner.push(sql.slice(i, i + size))
  scanner.end()
  return { statements: out, stats: scanner.stats }
}

describe('empty and degenerate input', () => {
  it.each([
    ['empty', ''],
    ['whitespace', ' \n\t\r\n '],
    ['comments only', '-- hello\n/* block ; */\n# mysql comment\n'],
    ['semicolons only', ';;;\n;'],
    ['no DDL', "INSERT INTO t VALUES (1);\nSELECT 'x';\nUPDATE t SET a = 1;"],
  ])('%s → no tables, no warnings', (_, sql) => {
    const s = parseSql(sql)
    expect(s.tables).toEqual([])
    expect(s.warnings).toEqual([])
  })

  it('does not hang or throw on an unterminated string or comment', () => {
    expect(ids("CREATE TABLE a (id int);\nINSERT INTO a VALUES ('never closed")).toEqual(['a'])
    expect(ids('CREATE TABLE a (id int);\n/* never closed')).toEqual(['a'])
    expect(ids('CREATE TABLE a (id int);\nCREATE FUNCTION f() AS $$ never closed')).toEqual(['a'])
  })

  it('handles a statement without a trailing semicolon at EOF', () => {
    expect(ids('CREATE TABLE a (id int)')).toEqual(['a'])
  })

  it('handles a table with no columns and CREATE TABLE … AS', () => {
    const s = parseSql('CREATE TABLE empty ();\nCREATE TABLE copy AS SELECT * FROM empty;')
    expect(s.tables.map((t) => [t.id, t.columns.length])).toEqual([['empty', 0]])
    expect(s.warnings[0]).toMatch(/Skipped table "copy"/)
  })
})

describe('quoting and comments', () => {
  it('ignores semicolons and comment markers inside strings and identifiers', () => {
    const sql = `
      CREATE TABLE "semi;colon" (
        "col;1" int DEFAULT 1,
        note varchar(20) DEFAULT 'a;b -- c /* d */',
        \`back;tick\` int COMMENT 'it''s; fine',
        [brack;et] int
      );
      CREATE TABLE after (id int);`
    const s = parseSql(sql)
    expect(s.tables.map((t) => t.id)).toEqual(['semi;colon', 'after'])
    expect(s.tables[0].columns.map((c) => c.name)).toEqual(['col;1', 'note', 'back;tick', 'brack;et'])
    expect(s.tables[0].columns[1].defaultValue).toBe("'a;b -- c /* d */'")
    expect(s.tables[0].columns[2].comment).toBe("it's; fine")
  })

  it('strips comments inside DDL, including ones containing quotes', () => {
    const s = parseSql(`CREATE TABLE t ( -- it's a comment; with a quote
      id int /* the "id"; */ PRIMARY KEY,
      # mysql style comment at line start
      name text
    );`)
    expect(s.tables[0].columns.map((c) => c.name)).toEqual(['id', 'name'])
    expect(s.tables[0].primaryKey).toEqual(['id'])
  })

  it('handles doubled and escaped quotes in identifiers', () => {
    const s = parseSql('CREATE TABLE "we""ird" ("a""b" int, `c``d` int, [e]]f] int);')
    expect(s.tables[0].id).toBe('we"ird')
    expect(s.tables[0].columns.map((c) => c.name)).toEqual(['a"b', 'c`d', 'e]f'])
  })

  it('supports unicode and quoted reserved words', () => {
    const s = parseSql('CREATE TABLE "订单" ("order" int PRIMARY KEY, "select" text, ü int);')
    expect(s.tables[0].id).toBe('订单')
    expect(s.tables[0].columns.map((c) => c.name)).toEqual(['order', 'select', 'ü'])
  })

  it('MySQL backslash escapes inside INSERT data', () => {
    const sql = "INSERT INTO t VALUES ('it\\'s; \\\\', \"q\\\"; x\");\nCREATE TABLE after (id int);"
    expect(ids(sql)).toEqual(['after'])
  })

  it('PostgreSQL standard strings treat backslash literally, E-strings do not', () => {
    const sql = [
      'SET standard_conforming_strings = on;',
      "INSERT INTO t VALUES ('C:\\');",
      "INSERT INTO t VALUES (E'it\\'s;');",
      'CREATE TABLE after (id int);',
    ].join('\n')
    expect(ids(sql)).toEqual(['after'])
  })

  it('SQL Server and SQLite scripts treat backslash literally', () => {
    expect(ids("SET ANSI_NULLS ON\nGO\nINSERT t VALUES (N'C:\\')\nGO\nCREATE TABLE a (id int)\nGO\n")).toEqual(['a'])
    expect(ids("PRAGMA foreign_keys=OFF;\nINSERT INTO t VALUES('x\\');\nCREATE TABLE a (id int);")).toEqual(['a'])
  })

  it('skips dollar-quoted bodies, including nested tags', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$
      BEGIN EXECUTE $$CREATE TABLE fake (id int);$$; END; $body$ LANGUAGE plpgsql;
      CREATE TABLE real_one (id int);`
    expect(ids(sql)).toEqual(['real_one'])
  })

  it('does not mistake $1 parameters or money for dollar quotes', () => {
    expect(ids("PREPARE p AS SELECT $1, '$5';\nCREATE TABLE a (price text DEFAULT '$9');")).toEqual(['a'])
  })
})

describe('dump-specific constructs', () => {
  it('skips COPY … FROM stdin data containing SQL-like text', () => {
    const { statements, stats } = scanStatements(PG_DUMP)
    expect(stats.copyBlocks).toBe(1)
    expect(statements.some((s) => /nope/.test(s))).toBe(false)
  })

  it('handles an empty COPY block', () => {
    expect(ids('COPY t (a) FROM stdin;\n\\.\nCREATE TABLE a (id int);')).toEqual(['a'])
  })

  it('handles MySQL DELIMITER blocks', () => {
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCREATE TABLE a (id int);'
    const { statements } = scanStatements(sql)
    expect(statements).toEqual(['CREATE TABLE a (id int)'])
  })

  it('splits SQL Server batches on GO without semicolons', () => {
    const { statements } = scanStatements(MSSQL_SCRIPT)
    expect(statements.filter((s) => s.startsWith('CREATE TABLE'))).toHaveLength(2)
    expect(statements.every((s) => !/\bGO\s*$/.test(s))).toBe(true)
  })

  it('accepts CRLF line endings', () => {
    const s = parseSql(MSSQL_SCRIPT.replace(/\n/g, '\r\n'))
    expect(s.tables).toHaveLength(2)
    expect(s.relationships).toHaveLength(1)
  })

  it('counts skipped INSERT statements', () => {
    expect(scanStatements(MYSQL_DUMP).stats.inserts).toBe(2)
    expect(scanStatements(SQLITE_DUMP).stats.inserts).toBe(3)
  })
})

describe('chunk boundaries', () => {
  const all = [MYSQL_DUMP, PG_DUMP, MSSQL_SCRIPT, SQLITE_DUMP]

  it.each([1, 2, 3, 5, 7, 13, 63, 64, 65, 127, 1000])('chunk size %i yields identical statements', (size) => {
    for (const sql of all) {
      const whole = scanStatements(sql)
      const chunked = scanChunked(sql, size)
      expect(chunked.statements).toEqual(whole.statements)
      expect(chunked.stats).toEqual(whole.stats)
    }
  })

  it('handles multi-byte characters split across stream chunks', async () => {
    const sql = 'CREATE TABLE "表" ("列😀" int);'
    const bytes = new TextEncoder().encode(sql)
    // A stream that yields one byte at a time splits every multi-byte sequence.
    const blob = {
      size: bytes.length,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const b of bytes) c.enqueue(new Uint8Array([b]))
            c.close()
          },
        }),
    } as unknown as Blob
    const { schema } = await importFiles([blob])
    expect(schema.tables[0].id).toBe('表')
    expect(schema.tables[0].columns[0].name).toBe('列😀')
  })
})

describe('encodings', () => {
  const sql = 'CREATE TABLE café (naïve int PRIMARY KEY);'

  it('reads UTF-8 with BOM', async () => {
    const file = new File([new Uint8Array([0xef, 0xbb, 0xbf]), sql], 'bom.sql')
    const { schema, files } = await importFiles([file])
    expect(schema.tables[0].id).toBe('café')
    expect(files[0].encoding).toBe('utf-8')
  })

  it('reads UTF-16 LE with BOM (SSMS default)', async () => {
    const buf = new Uint8Array(2 + sql.length * 2)
    buf[0] = 0xff
    buf[1] = 0xfe
    for (let i = 0; i < sql.length; i++) {
      buf[2 + i * 2] = sql.charCodeAt(i) & 0xff
      buf[3 + i * 2] = sql.charCodeAt(i) >> 8
    }
    const { schema, files } = await importFiles([new File([buf], 'utf16.sql')])
    expect(files[0].encoding).toBe('utf-16le')
    expect(schema.tables[0].columns[0].name).toBe('naïve')
  })
})

describe('non-SQL files', () => {
  it.each([
    ['png image', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d], 'not a text file'],
    ['gzip archive', [0x1f, 0x8b, 0x08, 0, 0, 0], 'gzip-compressed'],
    ['zip archive', [0x50, 0x4b, 0x03, 0x04, 0x14, 0], 'zip archive'],
  ])('skips a %s with a warning and still imports the other files', async (_, bytes, reason) => {
    const { schema, files } = await importFiles([
      new File([new Uint8Array(bytes)], 'not-sql.bin'),
      new File(['CREATE TABLE a (id int);'], 'a.sql'),
    ])
    expect(schema.tables.map((t) => t.id)).toEqual(['a'])
    expect(files[0].skipped).toContain(reason)
    expect(schema.warnings[0]).toContain('Skipped "not-sql.bin"')
  })
})

describe('relationship edge cases', () => {
  it('warns about foreign keys to unknown tables', () => {
    const s = parseSql('CREATE TABLE a (id int, b_id int REFERENCES missing(id));')
    expect(s.relationships).toEqual([])
    expect(s.warnings[0]).toMatch(/unknown table "missing"/)
  })

  it('warns about ALTER TABLE on unknown tables', () => {
    expect(parseSql('ALTER TABLE ghost ADD COLUMN x int;').warnings[0]).toMatch(/unknown table "ghost"/)
  })

  it('resolves composite foreign keys', () => {
    const s = parseSql(`
      CREATE TABLE p (a int, b int, PRIMARY KEY (a, b));
      CREATE TABLE c (id int PRIMARY KEY, pa int, pb int, FOREIGN KEY (pa, pb) REFERENCES p (a, b));`)
    expect(s.relationships[0]).toMatchObject({ fromColumns: ['pa', 'pb'], toColumns: ['a', 'b'] })
  })

  it('matches identifiers case-insensitively', () => {
    const s = parseSql('CREATE TABLE Users (ID int PRIMARY KEY);\nCREATE TABLE posts (user_id int REFERENCES USERS(id));')
    expect(s.relationships[0]).toMatchObject({ to: 'Users', toColumns: ['ID'] })
  })

  it('deduplicates the same foreign key declared twice', () => {
    const s = parseSql(`
      CREATE TABLE a (id int PRIMARY KEY);
      CREATE TABLE b (a_id int REFERENCES a(id), FOREIGN KEY (a_id) REFERENCES a(id));`)
    expect(s.relationships).toHaveLength(1)
  })
})

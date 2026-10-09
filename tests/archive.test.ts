import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { importFiles } from '../src/sql/import'
import { Bunzip2 } from '../src/sql/archive/bzip2'

const FIXTURES = new URL('./fixtures/archives/', import.meta.url)
const fixture = (name: string) => new File([readFileSync(new URL(name, FIXTURES))], name)

function hasTool(tool: string) {
  try {
    execFileSync(tool, ['--help'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const HAS = { bzip2: hasTool('bzip2'), xz: hasTool('xz'), zstd: hasTool('zstd') }
const compressWith = (tool: string, data: Uint8Array | string, args: string[] = ['-c']) =>
  new Uint8Array(execFileSync(tool, args, { input: data, maxBuffer: 1 << 30 }))

/** A File whose stream yields `chunk`-byte pieces, to exercise every split point. */
function chunkedFile(bytes: Uint8Array, name: string, chunk: number): File {
  class ChunkedFile extends File {
    override stream() {
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(c) {
          for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk))
          c.close()
        },
      })
    }
  }
  return new ChunkedFile([new Uint8Array(bytes)], name)
}

const tableIds = (r: Awaited<ReturnType<typeof importFiles>>) => r.schema.tables.map((t) => t.id).sort()

describe('compressed single files', () => {
  it.each([
    ['schema.sql.gz', 'gzip'],
    ['schema.sql.bz2', 'bzip2'],
    ['schema.sql.xz', 'xz'],
    ['schema.sql.zst', 'zstd'],
    ['multi-member.sql.gz', 'gzip'],
    ['multi-stream.sql.bz2', 'bzip2'],
  ])('%s is decompressed and parsed', async (name, format) => {
    const result = await importFiles([fixture(name)])
    expect(tableIds(result)).toEqual(['customers', 'orders'])
    expect(result.schema.relationships).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ format, entries: 1, tables: 2, inserts: 1 })
    expect(result.files[0].skipped).toBeUndefined()
    expect(result.schema.tables[0].source).toBe(name)
  })

  it.each(['schema.sql.gz', 'schema.sql.bz2', 'schema.sql.xz', 'schema.sql.zst', 'bundle.tar.gz'])(
    '%s gives identical results when the stream arrives one byte at a time',
    async (name) => {
      const bytes = readFileSync(new URL(name, FIXTURES))
      const whole = await importFiles([new File([bytes], name)])
      for (const size of [1, 3, 64]) {
        const chunked = await importFiles([chunkedFile(bytes, name, size)])
        expect(chunked.schema).toEqual(whole.schema)
      }
    },
  )

  it('reports progress in compressed bytes, ending at the file size', async () => {
    const file = fixture('schema.sql.xz')
    let last = 0
    await importFiles([file], (p) => (last = p.loaded))
    expect(last).toBe(file.size)
  })

  it('reads UTF-16 text inside gzip', async () => {
    const sql = 'CREATE TABLE ünïcode (id int);'
    const utf16 = new Uint8Array(2 + sql.length * 2)
    utf16.set([0xff, 0xfe])
    for (let i = 0; i < sql.length; i++) utf16[2 + i * 2] = sql.charCodeAt(i)
    const result = await importFiles([new File([gzipSync(utf16)], 'u16.sql.gz')])
    expect(tableIds(result)).toEqual(['ünïcode'])
    expect(result.files[0].encoding).toBe('utf-16le')
  })
})

describe('archives', () => {
  it('reads .sql and nested .sql.gz entries from a zip, skipping other files', async () => {
    const result = await importFiles([fixture('bundle.zip')])
    expect(tableIds(result)).toEqual(['customers', 'orders'])
    expect(result.schema.relationships).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ format: 'zip', entries: 2 })
    expect(result.schema.tables.find((t) => t.id === 'orders')?.source).toBe('bundle.zip/sub/orders.sql.gz')
    expect(result.schema.warnings).toContain('Skipped "bundle.zip/README.txt" (not a .sql file).')
    expect(result.schema.warnings.some((w) => w.includes('__MACOSX'))).toBe(false)
  })

  it('reads a .tar.gz with pax long paths and a nested .bz2 entry', async () => {
    const result = await importFiles([fixture('bundle.tar.gz')])
    expect(tableIds(result)).toEqual(['customers', 'orders'])
    expect(result.files[0]).toMatchObject({ format: 'gzip → tar', entries: 2 })
    const customers = result.schema.tables.find((t) => t.id === 'customers')!
    expect(customers.source).toMatch(/^bundle\.tar\.gz\/db\/(very_long_directory_name_){5}\/schema\/customers\.sql$/)
    expect(result.schema.warnings).toContain('Skipped "bundle.tar.gz/notes.txt" (not a .sql file).')
  })

  it('handles zip methods stored, deflate, bzip2, zstd and xz, plus zip64 records', async () => {
    const sql = (t: string) => new TextEncoder().encode(`CREATE TABLE ${t} (id int PRIMARY KEY);`)
    const entries: ZipEntry[] = [
      { name: 'a.sql', data: sql('a'), method: 0 },
      { name: 'b.sql', data: sql('b'), method: 8, compressed: deflateRawSync(sql('b')) },
    ]
    if (HAS.bzip2) entries.push({ name: 'c.sql', data: sql('c'), method: 12, compressed: compressWith('bzip2', sql('c')) })
    if (HAS.zstd) entries.push({ name: 'd.sql', data: sql('d'), method: 93, compressed: compressWith('zstd', sql('d'), ['-q', '-c']) })
    if (HAS.xz) entries.push({ name: 'e.sql', data: sql('e'), method: 95, compressed: compressWith('xz', sql('e')) })
    const expected = entries.map((e) => e.name[0])
    for (const zip64 of [false, true]) {
      const result = await importFiles([new File([makeZip(entries, zip64)], 'methods.zip')])
      expect(tableIds(result)).toEqual(expected)
      expect(result.files[0].entries).toBe(expected.length)
    }
  })

  it('skips encrypted and unknown-method zip entries with a warning', async () => {
    const data = new TextEncoder().encode('CREATE TABLE ok (id int);')
    const zip = makeZip([
      { name: 'ok.sql', data, method: 0 },
      { name: 'secret.sql', data, method: 0, flags: 1 },
      { name: 'weird.sql', data, method: 99 },
    ])
    const result = await importFiles([new File([zip], 'mixed.zip')])
    expect(tableIds(result)).toEqual(['ok'])
    expect(result.schema.warnings).toContain('Skipped "mixed.zip/secret.sql": encrypted zip entries are not supported.')
    expect(result.schema.warnings).toContain('Skipped "mixed.zip/weird.sql": unsupported zip compression method 99.')
  })

  it('treats an archive with no SQL files as skipped', async () => {
    const zip = makeZip([{ name: 'readme.md', data: new TextEncoder().encode('# hi'), method: 0 }])
    const result = await importFiles([new File([zip], 'docs.zip')])
    expect(result.files[0].skipped).toBe('the archive contains no .sql files')
  })
})

describe('unsupported and corrupt input', () => {
  it.each([
    ['backup.7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4], '7-Zip'],
    ['backup.rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0], 'RAR'],
    ['db.dump', [...new TextEncoder().encode('PGDMP'), 1, 14, 0], 'pg_restore'],
    ['app.db', [...new TextEncoder().encode('SQLite format 3'), 0], 'sqlite3'],
  ])('explains how to handle %s', async (name, bytes, hint) => {
    const result = await importFiles([new File([new Uint8Array(bytes)], name), new File(['CREATE TABLE a (id int);'], 'a.sql')])
    expect(tableIds(result)).toEqual(['a'])
    expect(result.files[0].skipped).toContain(hint)
  })

  it.each([40, 100, 152])('reports a gzip file truncated to %i bytes', async (keep) => {
    // 152 of 155 bytes: only part of the trailer is missing, which the decoder alone accepts.
    const gz = readFileSync(new URL('schema.sql.gz', FIXTURES))
    const result = await importFiles([new File([gz.subarray(0, keep)], 'cut.sql.gz')])
    expect(result.files[0].skipped).toMatch(/could not be read|truncated/)
  })

  it('reports a zip without a central directory', async () => {
    const result = await importFiles([new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0])], 'cut.zip')])
    expect(result.files[0].skipped).toBe('it is not a readable zip archive (no central directory)')
  })

  it('reports a corrupted bzip2 file', async () => {
    const bz = new Uint8Array(readFileSync(new URL('schema.sql.bz2', FIXTURES)))
    bz[60] ^= 0xff
    const result = await importFiles([new File([bz], 'bad.sql.bz2')])
    expect(result.files[0].skipped).toMatch(/could not be read/)
  })
})

describe('bzip2 decoder', () => {
  function bunzip(compressed: Uint8Array, chunk = 65536): Uint8Array {
    const parts: Uint8Array[] = []
    const d = new Bunzip2((c) => parts.push(c.slice()))
    for (let i = 0; i < compressed.length; i += chunk) d.push(compressed.subarray(i, i + chunk))
    d.push(new Uint8Array(0), true)
    return Buffer.concat(parts)
  }

  it.skipIf(!HAS.bzip2)('matches the bzip2 tool on random, run-heavy and multi-block data at every level', () => {
    const runs = Buffer.concat([Buffer.alloc(5000, 0x41), Buffer.from('xyz'), Buffer.alloc(300, 0x42), Buffer.alloc(4, 0x43), Buffer.alloc(5, 0)])
    expect(Buffer.from(bunzip(compressWith('bzip2', runs))).equals(runs)).toBe(true)
    const rand = randomBytes(2_500_000)
    expect(Buffer.from(bunzip(compressWith('bzip2', rand, ['-c', '-9']), 7919)).equals(rand)).toBe(true)
    for (const level of ['-1', '-5']) {
      const part = rand.subarray(0, 300_000)
      expect(Buffer.from(bunzip(compressWith('bzip2', part, ['-c', level]), 1)).equals(part)).toBe(true)
    }
    expect(bunzip(compressWith('bzip2', new Uint8Array(0)))).toHaveLength(0)
  })

  it('rejects truncated input', () => {
    const bz = new Uint8Array(readFileSync(new URL('schema.sql.bz2', FIXTURES)))
    expect(() => bunzip(bz.subarray(0, bz.length - 10))).toThrow(/Unexpected end/)
  })
})

describe('large compressed dumps', () => {
  const rows = Array.from({ length: 150_000 }, (_, i) => `INSERT INTO t VALUES (${i}, 'name ${i}; -- x', '{"k":"v"}');`).join('\n')
  const sql = `CREATE TABLE t (id int PRIMARY KEY, name text, payload json);\n${rows}\nCREATE TABLE tail (id int, t_id int REFERENCES t(id));\n`
  const bytes = new TextEncoder().encode(sql)

  it.each([
    ['gzip', true, () => gzipSync(bytes)],
    ['bzip2', HAS.bzip2, () => compressWith('bzip2', bytes)],
    ['xz', HAS.xz, () => compressWith('xz', bytes, ['-c', '-T1'])],
    ['zstd', HAS.zstd, () => compressWith('zstd', bytes, ['-q', '-c'])],
  ] as const)('streams a ~10 MB %s dump', async (format, available, make) => {
    if (!available) return
    const compressed = make()
    const t = performance.now()
    const result = await importFiles([new File([compressed], `big.sql.${format}`)])
    const ms = performance.now() - t
    console.log(`[perf] ${format}: ${(bytes.length / 1048576).toFixed(1)} MB SQL (${(compressed.length / 1048576).toFixed(1)} MB compressed) in ${ms.toFixed(0)} ms`)
    expect(tableIds(result)).toEqual(['t', 'tail'])
    expect(result.files[0]).toMatchObject({ format, textBytes: bytes.length, inserts: 150_000 })
    expect(result.ddl[0].length).toBeLessThan(500)
    expect(ms).toBeLessThan(20_000)
  })
})

// ---------------------------------------------------------------------------
// Minimal zip writer for tests (supports forcing zip64 records).

interface ZipEntry {
  name: string
  data: Uint8Array
  method: number
  compressed?: Uint8Array
  flags?: number
}

const CRC32 = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return (b: Uint8Array) => {
    let c = 0xffffffff
    for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
})()

function makeZip(entries: ZipEntry[], zip64 = false): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const enc = new TextEncoder()
  for (const e of entries) {
    const name = enc.encode(e.name)
    const body = e.compressed ?? e.data
    const crc = CRC32(e.data)
    const localExtra = zip64 ? 20 : 0
    const local = new DataView(new ArrayBuffer(30 + name.length + localExtra))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, zip64 ? 45 : 20, true)
    local.setUint16(6, (e.flags ?? 0) | 0x800, true)
    local.setUint16(8, e.method, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, zip64 ? 0xffffffff : body.length, true)
    local.setUint32(22, zip64 ? 0xffffffff : e.data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, localExtra, true)
    new Uint8Array(local.buffer).set(name, 30)
    if (zip64) {
      local.setUint16(30 + name.length, 1, true)
      local.setUint16(32 + name.length, 16, true)
      local.setBigUint64(34 + name.length, BigInt(e.data.length), true)
      local.setBigUint64(42 + name.length, BigInt(body.length), true)
    }
    const centralExtra = zip64 ? 28 : 0
    const cd = new DataView(new ArrayBuffer(46 + name.length + centralExtra))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 45, true)
    cd.setUint16(6, zip64 ? 45 : 20, true)
    cd.setUint16(8, (e.flags ?? 0) | 0x800, true)
    cd.setUint16(10, e.method, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, zip64 ? 0xffffffff : body.length, true)
    cd.setUint32(24, zip64 ? 0xffffffff : e.data.length, true)
    cd.setUint16(28, name.length, true)
    cd.setUint16(30, centralExtra, true)
    cd.setUint32(42, zip64 ? 0xffffffff : offset, true)
    new Uint8Array(cd.buffer).set(name, 46)
    if (zip64) {
      const x = 46 + name.length
      cd.setUint16(x, 1, true)
      cd.setUint16(x + 2, 24, true)
      cd.setBigUint64(x + 4, BigInt(e.data.length), true)
      cd.setBigUint64(x + 12, BigInt(body.length), true)
      cd.setBigUint64(x + 20, BigInt(offset), true)
    }
    parts.push(new Uint8Array(local.buffer), body)
    central.push(new Uint8Array(cd.buffer))
    offset += local.byteLength + body.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const tail: Uint8Array[] = []
  if (zip64) {
    const rec = new DataView(new ArrayBuffer(56))
    rec.setUint32(0, 0x06064b50, true)
    rec.setBigUint64(4, 44n, true)
    rec.setUint16(12, 45, true)
    rec.setUint16(14, 45, true)
    rec.setBigUint64(24, BigInt(entries.length), true)
    rec.setBigUint64(32, BigInt(entries.length), true)
    rec.setBigUint64(40, BigInt(cdSize), true)
    rec.setBigUint64(48, BigInt(offset), true)
    const loc = new DataView(new ArrayBuffer(20))
    loc.setUint32(0, 0x07064b50, true)
    loc.setBigUint64(8, BigInt(offset + cdSize), true)
    loc.setUint32(16, 1, true)
    tail.push(new Uint8Array(rec.buffer), new Uint8Array(loc.buffer))
  }
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, zip64 ? 0xffff : entries.length, true)
  eocd.setUint16(10, zip64 ? 0xffff : entries.length, true)
  eocd.setUint32(12, zip64 ? 0xffffffff : cdSize, true)
  eocd.setUint32(16, zip64 ? 0xffffffff : offset, true)
  tail.push(new Uint8Array(eocd.buffer))
  return new Uint8Array(Buffer.concat([...parts, ...central, ...tail]))
}

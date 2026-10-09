/*
 * Opens uploaded files as streams of SQL text, unwrapping compression and
 * archives in the browser:
 *
 *   gzip (.gz)  — fflate (the native DecompressionStream stops after the first
 *                 member, so multi-member files from pigz/bgzip would fail)
 *   zip         — central directory read via Blob.slice (random access, no full load);
 *                 stored / deflate (native) / bzip2 / zstd / xz entries; password-protected
 *                 entries (ZipCrypto and WinZip AES) via ./zipcrypto.ts
 *   tar         — streaming reader (ustar, GNU long names, pax paths)
 *   zstd (.zst) — fzstd
 *   bzip2 (.bz2)— ./bzip2.ts
 *   xz (.xz)    — xz-decompress (WebAssembly)
 *
 * Formats are detected from magic bytes, not file extensions, and layers nest
 * (e.g. .tar.gz, or a .sql.gz inside a .zip).
 */
import { Gunzip } from 'fflate'
import { Decompress as ZstdDecompress } from 'fzstd'
import { XzReadableStream } from 'xz-decompress'
import { Bunzip2 } from './bzip2'
import { AES_SALT_LENGTH, Crc32, openWinZipAes, openZipCrypto } from './zipcrypto'

export type Compression = 'gzip' | 'zstd' | 'bzip2' | 'xz'
export type Format = Compression | 'zip' | 'tar' | 'text'

export interface Entry {
  /** Display name, e.g. "dump.sql.gz" or "backup.zip/schema.sql". */
  name: string
  stream: ReadableStream<Uint8Array>
  /** Layers unwrapped to reach this entry, outermost first (e.g. ["gzip", "tar"]). */
  layers: Format[]
}

const MAX_DEPTH = 4
const SQL_ENTRY = /\.(sql|ddl|psql|pgsql|mysql|dump)$/i
const COMPRESSED_EXT = /\.(gz|tgz|bz2|tbz2?|xz|txz|zst|zstd)$/i
const ARCHIVE_EXT = /\.(zip|tar)$/i

/** Formats we recognise but cannot read, with advice for the user. */
const UNSUPPORTED: [string, (b: Uint8Array) => boolean][] = [
  ['a 7-Zip archive; extract the .sql file or re-compress as .zip, .gz, .bz2, .xz or .zst', (b) => b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf],
  ['a RAR archive; extract the .sql file first', (b) => b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21],
  ['a PostgreSQL custom-format dump; convert it with "pg_restore -f out.sql <file>"', (b) => ascii(b, 0, 5) === 'PGDMP'],
  ['a SQLite database file, not SQL text; export it with "sqlite3 db .dump > out.sql"', (b) => ascii(b, 0, 15) === 'SQLite format 3'],
  ['LZ4-compressed, which is not supported; use gzip, bzip2, xz or zstd', (b) => b[0] === 0x04 && b[1] === 0x22 && b[2] === 0x4d && b[3] === 0x18],
]

function ascii(b: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...b.subarray(start, end))
}

export function detect(head: Uint8Array): Format {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip'
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd'
  if (head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68 && head[3] >= 0x31 && head[3] <= 0x39) return 'bzip2'
  if (head[0] === 0xfd && ascii(head, 1, 6) === '7zXZ\0') return 'xz'
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return 'zip'
  if (head.length >= 262 && ascii(head, 257, 262) === 'ustar') return 'tar'
  return 'text'
}

export function unsupportedReason(head: Uint8Array): string | null {
  for (const [reason, test] of UNSUPPORTED) if (test(head)) return reason
  return null
}

export class ArchiveError extends Error {}

export function decompress(format: Compression, stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  switch (format) {
    case 'gzip':
      return stream.pipeThrough(pushTransform((onData) => new CheckedGunzip(onData)))
    case 'bzip2':
      return stream.pipeThrough(pushTransform((onData) => new Bunzip2(onData)))
    case 'xz':
      return new XzReadableStream(stream)
    case 'zstd':
      return stream.pipeThrough(pushTransform((onData) => new ZstdDecompress((chunk) => onData(chunk))))
  }
}

/**
 * fflate's Gunzip with truncation detection: it silently accepts a cut-off final member,
 * so compare the trailer's ISIZE (last 4 bytes) with the bytes the last member produced.
 */
class CheckedGunzip {
  private gunzip: Gunzip
  private memberBytes = 0
  private total = 0
  private tail = new Uint8Array(8)

  constructor(onData: (chunk: Uint8Array) => void) {
    this.gunzip = new Gunzip((chunk) => {
      this.memberBytes += chunk.byteLength
      onData(chunk)
    })
    this.gunzip.onmember = () => {
      this.memberBytes = 0
    }
  }

  push(chunk: Uint8Array, final = false) {
    this.total += chunk.byteLength
    if (chunk.byteLength >= 8) this.tail = chunk.slice(-8)
    else if (chunk.byteLength) {
      const next = new Uint8Array(8)
      next.set(this.tail.subarray(chunk.byteLength))
      next.set(chunk, 8 - chunk.byteLength)
      this.tail = next
    }
    this.gunzip.push(chunk, final)
    if (!final) return
    const isize = new DataView(this.tail.buffer, this.tail.byteOffset, 8).getUint32(4, true)
    if (this.total < 18 || isize !== this.memberBytes % 2 ** 32) throw new Error('the gzip data is truncated')
  }
}

/** Adapts a push-style decoder (`push(chunk, final)` + data callback) to a TransformStream. */
function pushTransform(create: (onData: (chunk: Uint8Array) => void) => { push(chunk: Uint8Array, final?: boolean): unknown }) {
  let decoder: ReturnType<typeof create>
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      decoder = create((chunk) => controller.enqueue(chunk))
    },
    transform(chunk) {
      decoder.push(chunk)
    },
    flush() {
      decoder.push(new Uint8Array(0), true)
    },
  })
}

/** Counts bytes flowing through a stream (used for progress on the compressed input). */
export function counted(stream: ReadableStream<Uint8Array>, onBytes: (n: number) => void): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes(chunk.byteLength)
        controller.enqueue(chunk)
      },
    }),
  )
}

/** Reads at least `n` bytes (if available) without consuming them from the returned stream. */
async function peek(stream: ReadableStream<Uint8Array>, n: number): Promise<[Uint8Array, ReadableStream<Uint8Array>]> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < n) {
    const { value, done } = await reader.read()
    if (done) break
    if (value.byteLength) {
      chunks.push(value)
      size += value.byteLength
    }
  }
  const head = concat(chunks, Math.min(size, n))
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
    },
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return [head, rest]
}

function concat(chunks: Uint8Array[], limit = Infinity): Uint8Array {
  const total = Math.min(
    limit,
    chunks.reduce((n, c) => n + c.byteLength, 0),
  )
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    if (o >= total) break
    const take = Math.min(c.byteLength, total - o)
    out.set(c.subarray(0, take), o)
    o += take
  }
  return out
}

function stripCompressionExt(name: string): string {
  return name
    .replace(/\.tgz$/i, '.tar')
    .replace(/\.tbz2?$/i, '.tar')
    .replace(/\.txz$/i, '.tar')
    .replace(COMPRESSED_EXT, '')
}

/** Entries inside zip/tar archives worth scanning: SQL files, possibly compressed or nested archives. */
function wantedEntry(path: string): boolean {
  const base = path.split('/').pop() ?? path
  if (!base || base.startsWith('.') || path.startsWith('__MACOSX/')) return false
  const inner = stripCompressionExt(base)
  return SQL_ENTRY.test(inner) || ARCHIVE_EXT.test(inner)
}

export interface PasswordRequest {
  archive: string
  /** The first encrypted entry that needs the password. */
  entry: string
  /** 0 for the first prompt; higher after wrong passwords. */
  attempt: number
}

export interface PasswordOptions {
  /** Passwords that already worked during this import; tried before prompting. */
  known: string[]
  /** Ask the user; resolves to null when they choose to skip. */
  ask?: (request: PasswordRequest) => Promise<string | null>
}

export interface OpenOptions {
  /** Called with the number of input (compressed) bytes consumed. */
  onBytes?: (n: number) => void
  /** Non-fatal notes, e.g. archive entries that were skipped. */
  onNote?: (message: string) => void
  passwords?: PasswordOptions
  /** Called when an encrypted entry is opened, so callers can avoid persisting its contents. */
  onDecrypt?: () => void
}

/** Opens a file and yields every SQL text entry inside it (a plain file yields itself). */
export async function* openEntries(file: Blob, name: string, opts: OpenOptions = {}): AsyncGenerator<Entry> {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer())
  if (detect(head) === 'zip') {
    yield* zipEntries(file, name, [], opts)
    return
  }
  const stream = opts.onBytes ? counted(file.stream(), opts.onBytes) : file.stream()
  yield* expandStream(stream, name, [], opts)
}

async function* expandStream(
  stream: ReadableStream<Uint8Array>,
  name: string,
  layers: Format[],
  opts: OpenOptions,
): AsyncGenerator<Entry> {
  const [head, rest] = await peek(stream, 512)
  const format = detect(head)
  if (format === 'text') {
    const reason = unsupportedReason(head)
    if (reason) {
      await rest.cancel()
      throw new ArchiveError(`it is ${reason}`)
    }
    yield { name, stream: rest, layers }
    return
  }
  if (layers.length >= MAX_DEPTH) {
    await rest.cancel()
    throw new ArchiveError('it is nested too deeply in archives')
  }
  if (format === 'zip') {
    // A zip needs random access, so a zip inside another stream is buffered in memory.
    const blob = await new Response(rest).blob()
    yield* zipEntries(blob, name, layers, { ...opts, onBytes: undefined })
    return
  }
  if (format === 'tar') {
    yield* tarEntries(rest, name, [...layers, 'tar'], opts)
    return
  }
  yield* expandStream(decompress(format, rest), name, [...layers, format], opts)
}

/** Inside an archive, one unreadable entry is reported and skipped rather than failing the whole upload. */
async function* entrySafely(entries: AsyncGenerator<Entry>, path: string, opts: OpenOptions): AsyncGenerator<Entry> {
  try {
    yield* entries
  } catch (e) {
    if (!(e instanceof ArchiveError)) throw e
    opts.onNote?.(`Skipped "${path}": ${e.message}.`)
  }
}

// ---------------------------------------------------------------------------
// tar

class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private chunk: Uint8Array = new Uint8Array(0)
  private offset = 0

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  /** Returns up to `max` bytes (never more than one underlying chunk), or null at end of stream. */
  async read(max: number): Promise<Uint8Array | null> {
    while (this.offset >= this.chunk.byteLength) {
      const { value, done } = await this.reader.read()
      if (done) return null
      this.chunk = value
      this.offset = 0
    }
    const take = Math.min(max, this.chunk.byteLength - this.offset)
    const out = this.chunk.subarray(this.offset, this.offset + take)
    this.offset += take
    return out
  }

  async readExact(n: number): Promise<Uint8Array | null> {
    const parts: Uint8Array[] = []
    let got = 0
    while (got < n) {
      const part = await this.read(n - got)
      if (!part) return got === 0 ? null : concat(parts)
      parts.push(part)
      got += part.byteLength
    }
    return parts.length === 1 ? parts[0] : concat(parts)
  }

  async skip(n: number) {
    while (n > 0) {
      const part = await this.read(n)
      if (!part) return
      n -= part.byteLength
    }
  }

  cancel() {
    return this.reader.cancel()
  }
}

function tarString(b: Uint8Array, start: number, len: number): string {
  const slice = b.subarray(start, start + len)
  const nul = slice.indexOf(0)
  return new TextDecoder().decode(nul >= 0 ? slice.subarray(0, nul) : slice)
}

function tarSize(b: Uint8Array): number {
  if (b[124] & 0x80) {
    // GNU base-256 encoding for large files
    let n = 0
    for (let i = 125; i < 136; i++) n = n * 256 + b[i]
    return n
  }
  return parseInt(tarString(b, 124, 12).trim() || '0', 8)
}

async function* tarEntries(stream: ReadableStream<Uint8Array>, archive: string, layers: Format[], opts: OpenOptions): AsyncGenerator<Entry> {
  const reader = new ByteReader(stream)
  let longName: string | null = null
  try {
    for (;;) {
      const header = await reader.readExact(512)
      if (!header || header.byteLength < 512 || header.every((b) => b === 0)) return
      const size = tarSize(header)
      const padded = Math.ceil(size / 512) * 512
      const type = String.fromCharCode(header[156] || 48)
      if (type === 'L' || type === 'x') {
        const data = (await reader.readExact(padded)) ?? new Uint8Array(0)
        const text = new TextDecoder().decode(data.subarray(0, size))
        if (type === 'L') longName = text.replace(/\0+$/, '')
        else {
          const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)
          if (path) longName = path[1]
        }
        continue
      }
      const prefix = ascii(header, 257, 262) === 'ustar' ? tarString(header, 345, 155) : ''
      const path = longName ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100))
      longName = null

      if ((type !== '0' && type !== '7') || !wantedEntry(path)) {
        if ((type === '0' || type === '7') && size > 0) opts.onNote?.(`Skipped "${archive}/${path}" (not a .sql file).`)
        await reader.skip(padded)
        continue
      }

      let remaining = size
      let finished = false
      const entryStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (remaining <= 0) {
            finished = true
            controller.close()
            return
          }
          const part = await reader.read(Math.min(remaining, 1 << 20))
          if (!part) {
            controller.error(new ArchiveError(`"${path}" is truncated`))
            return
          }
          remaining -= part.byteLength
          // Copy: the reader reuses its chunk buffer.
          controller.enqueue(part.slice())
        },
      })
      yield* entrySafely(expandStream(entryStream, `${archive}/${path}`, layers, opts), `${archive}/${path}`, opts)
      // Skip whatever the consumer did not read, plus padding.
      await reader.skip(finished ? padded - size : remaining + (padded - size))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// zip

const ZIP_METHODS: Record<number, Compression | 'deflate' | 'store'> = { 0: 'store', 8: 'deflate', 12: 'bzip2', 93: 'zstd', 95: 'xz' }

async function readBytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer())
}

function u64(view: DataView, offset: number) {
  return Number(view.getBigUint64(offset, true))
}

async function* zipEntries(file: Blob, archive: string, layers: Format[], opts: OpenOptions): AsyncGenerator<Entry> {
  // End of central directory record (possibly preceded by a comment of up to 64 kB).
  const tailStart = Math.max(0, file.size - 65_557)
  const tail = await readBytes(file, tailStart, file.size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ArchiveError('it is not a readable zip archive (no central directory)')

  let count = tail.getUint16(eocd + 10, true)
  let cdSize = tail.getUint32(eocd + 12, true)
  let cdOffset = tail.getUint32(eocd + 16, true)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new ArchiveError('it is a malformed zip64 archive')
    const z64Offset = u64(tail, loc + 8)
    const z64 = await readBytes(file, z64Offset, z64Offset + 56)
    if (z64.getUint32(0, true) !== 0x06064b50) throw new ArchiveError('it is a malformed zip64 archive')
    count = u64(z64, 32)
    cdSize = u64(z64, 40)
    cdOffset = u64(z64, 48)
  }

  const cd = await readBytes(file, cdOffset, cdOffset + cdSize)
  const utf8 = new TextDecoder()
  const latin1 = new TextDecoder('latin1')
  let p = 0
  let yielded = 0
  let encryptedSkipped = 0
  let skipEncrypted = false
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new ArchiveError('it has a corrupt zip central directory')
    const flags = cd.getUint16(p + 8, true)
    const method = cd.getUint16(p + 10, true)
    const crc = cd.getUint32(p + 16, true)
    let aes: { strength: number; method: number } | null = null
    let compSize = cd.getUint32(p + 20, true)
    let size = cd.getUint32(p + 24, true)
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    let localOffset = cd.getUint32(p + 42, true)
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)
    const path = (flags & 0x800 ? utf8 : latin1).decode(nameBytes)

    // zip64 extended information extra field
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true)
      const len = cd.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) {
          size = u64(cd, q)
          q += 8
        }
        if (compSize === 0xffffffff) {
          compSize = u64(cd, q)
          q += 8
        }
        if (localOffset === 0xffffffff) localOffset = u64(cd, q)
      } else if (id === 0x9901 && len >= 7) {
        // WinZip AES: version(2) "AE"(2) strength(1) actual-method(2)
        aes = { strength: cd.getUint8(e + 8), method: cd.getUint16(e + 9, true) }
      }
      e += 4 + len
    }
    p = extraEnd + commentLen

    if (path.endsWith('/') || !wantedEntry(path)) {
      if (!path.endsWith('/') && !path.startsWith('__MACOSX/')) opts.onNote?.(`Skipped "${archive}/${path}" (not a .sql file).`)
      continue
    }
    const actualMethod = method === 99 && aes ? aes.method : method
    const kind = ZIP_METHODS[actualMethod]
    if (!kind) {
      opts.onNote?.(`Skipped "${archive}/${path}": unsupported zip compression method ${actualMethod}.`)
      continue
    }

    const local = await readBytes(file, localOffset, localOffset + 30)
    if (local.getUint32(0, true) !== 0x04034b50) throw new ArchiveError(`it has a corrupt entry "${path}"`)
    const dataStart = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true)

    let start = dataStart
    let end = dataStart + compSize
    let decrypt: ((chunk: Uint8Array) => Uint8Array) | null = null
    if (flags & 1) {
      if (skipEncrypted) {
        encryptedSkipped++
        continue
      }
      const unlocked = await unlockEntry(file, archive, path, { dataStart, compSize, crc, dosTime: local.getUint16(10, true), aes }, opts)
      if (!unlocked) {
        skipEncrypted = true
        encryptedSkipped++
        continue
      }
      ;({ start, end, decrypt } = unlocked)
      opts.onDecrypt?.()
    }

    let raw: ReadableStream<Uint8Array> = file.slice(start, end).stream()
    if (opts.onBytes) raw = counted(raw, opts.onBytes)
    if (decrypt) raw = raw.pipeThrough(mapStream(decrypt))
    let stream =
      kind === 'store'
        ? raw
        : kind === 'deflate'
          ? raw.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>)
          : decompress(kind, raw)
    // A wrong password can slip past the 1-byte (ZipCrypto) or 2-byte (AES) check; the CRC catches it.
    // AE-2 entries store no CRC (0), relying on the AES verifier instead.
    if (decrypt && crc !== 0) stream = stream.pipeThrough(crcCheck(crc))
    yielded++
    yield* entrySafely(expandStream(stream, `${archive}/${path}`, [...layers, 'zip'], opts), `${archive}/${path}`, opts)
  }
  if (encryptedSkipped > 0 && yielded > 0) {
    opts.onNote?.(`Skipped ${encryptedSkipped} password-protected file${encryptedSkipped === 1 ? '' : 's'} in "${archive}" (no password given).`)
  }
  if (yielded === 0) {
    throw new ArchiveError(encryptedSkipped ? 'it is password-protected and no password was given' : 'the archive contains no .sql files')
  }
}

interface EncryptedEntry {
  dataStart: number
  compSize: number
  crc: number
  dosTime: number
  aes: { strength: number; method: number } | null
}

/** Finds a working password (known ones first, then by asking) and returns the plaintext range and decryptor. */
async function unlockEntry(file: Blob, archive: string, path: string, entry: EncryptedEntry, opts: OpenOptions) {
  const { dataStart, compSize, crc, dosTime, aes } = entry
  let tryPassword: (password: string) => Promise<((chunk: Uint8Array) => Uint8Array) | null>
  let start: number
  let end: number
  if (aes) {
    const saltLen = AES_SALT_LENGTH[aes.strength]
    if (!saltLen) throw new ArchiveError(`"${path}" uses an unknown AES strength`)
    const head = new Uint8Array(await file.slice(dataStart, dataStart + saltLen + 2).arrayBuffer())
    start = dataStart + saltLen + 2
    end = dataStart + compSize - 10 // 10-byte authentication code follows the data
    tryPassword = async (pw) => {
      const ctr = await openWinZipAes(pw, aes.strength, head.subarray(0, saltLen), head.subarray(saltLen))
      return ctr && ((chunk) => ctr.apply(chunk))
    }
  } else {
    const header = new Uint8Array(await file.slice(dataStart, dataStart + 12).arrayBuffer())
    start = dataStart + 12
    end = dataStart + compSize
    tryPassword = async (pw) => {
      const d = openZipCrypto(pw, header, crc, dosTime)
      return d && ((chunk) => d.decrypt(chunk))
    }
  }

  const passwords = opts.passwords
  for (const pw of passwords?.known ?? []) {
    const decrypt = await tryPassword(pw)
    if (decrypt) return { start, end, decrypt }
  }
  if (!passwords?.ask) return null
  for (let attempt = 0; ; attempt++) {
    const pw = await passwords.ask({ archive, entry: path, attempt })
    if (pw === null) return null
    const decrypt = await tryPassword(pw)
    if (decrypt) {
      if (!passwords.known.includes(pw)) passwords.known.push(pw)
      return { start, end, decrypt }
    }
  }
}

function mapStream(fn: (chunk: Uint8Array) => Uint8Array) {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(fn(chunk.slice()))
    },
  })
}

function crcCheck(expected: number) {
  const crc = new Crc32()
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      crc.update(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      if (crc.value !== expected) throw new ArchiveError('the password is incorrect or the data is corrupted')
    },
  })
}

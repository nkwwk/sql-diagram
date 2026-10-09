import { SchemaBuilder } from './parser'
import { StatementScanner, type ScanStats } from './scanner'
import { ArchiveError, openEntries, type Entry, type Format } from './archive/archive'
import type { Schema } from './types'

export interface FileReport extends ScanStats {
  name: string
  /** Size in bytes (compressed size for archives). */
  size: number
  /** Number of tables created by this file. */
  tables: number
  /** Parse time in milliseconds. */
  ms: number
  encoding: string
  /** Compression / archive layers, e.g. "gzip" or "gzip → tar"; absent for plain text. */
  format?: string
  /** SQL files read from inside the upload (1 for a plain or single compressed file). */
  entries: number
  /** Decompressed bytes of SQL text read. */
  textBytes: number
  /** Set when the file was skipped (e.g. it is not a text file). */
  skipped?: string
}

export interface ImportProgress {
  fileIndex: number
  fileCount: number
  name: string
  loaded: number
  total: number
}

export interface ImportResult {
  schema: Schema
  files: FileReport[]
  /** The DDL statements kept from each file — small enough to persist and re-import. */
  ddl: string[]
}

const LAYER_NAMES: Record<Format, string> = { gzip: 'gzip', bzip2: 'bzip2', xz: 'xz', zstd: 'zstd', zip: 'zip', tar: 'tar', text: 'text' }

function detectEncoding(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le'
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be'
  // UTF-16 without BOM: many NUL bytes in the first few characters.
  if (head.length >= 4 && head[1] === 0 && head[3] === 0 && head[0] !== 0) return 'utf-16le'
  return 'utf-8'
}

function isBinary(head: Uint8Array, encoding: string): boolean {
  if (encoding !== 'utf-8') return false
  const n = Math.min(head.length, 4096)
  for (let i = 0; i < n; i++) if (head[i] === 0) return true
  return false
}

interface EntryResult {
  stats: ScanStats
  encoding: string
  textBytes: number
  binary: boolean
}

/** Decodes one SQL text entry and feeds it through a fresh scanner. */
async function scanEntry(entry: Entry, onStatement: (stmt: string) => void): Promise<EntryResult> {
  const scanner = new StatementScanner(onStatement)
  const reader = entry.stream.getReader()
  let decoder: TextDecoder | null = null
  let encoding = 'utf-8'
  let textBytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value.byteLength) continue
      if (!decoder) {
        encoding = detectEncoding(value)
        if (isBinary(value, encoding)) {
          await reader.cancel()
          return { stats: scanner.stats, encoding, textBytes: 0, binary: true }
        }
        decoder = new TextDecoder(encoding)
      }
      textBytes += value.byteLength
      scanner.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
  if (decoder) scanner.push(decoder.decode())
  scanner.end()
  return { stats: scanner.stats, encoding, textBytes, binary: false }
}

/**
 * Stream one or more SQL files — plain, compressed or archived — through the
 * scanner and build a single schema. Only DDL text is retained, so memory stays
 * flat regardless of how much INSERT / COPY data the dumps contain.
 */
export async function importFiles(files: Blob[], onProgress?: (p: ImportProgress) => void): Promise<ImportResult> {
  const builder = new SchemaBuilder()
  const reports: FileReport[] = []
  const ddl: string[] = []
  const notes: string[] = []

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]
    const name = file instanceof File ? file.name : `file-${fileIndex + 1}.sql`
    const started = performance.now()
    const kept: string[] = []
    const report: FileReport = {
      name,
      size: file.size,
      tables: 0,
      ms: 0,
      encoding: 'utf-8',
      entries: 0,
      textBytes: 0,
      chars: 0,
      statements: 0,
      kept: 0,
      inserts: 0,
      copyBlocks: 0,
    }
    let loaded = 0
    const fileNotes: string[] = []

    try {
      const entries = openEntries(file, name, {
        onBytes: (n) => {
          loaded += n
          onProgress?.({ fileIndex, fileCount: files.length, name, loaded, total: file.size })
        },
        onNote: (m) => fileNotes.push(m),
      })
      for await (const entry of entries) {
        // Describe the upload's own layers, up to and including any archive container.
        const container = entry.layers.findIndex((l) => l === 'zip' || l === 'tar')
        const outer = container >= 0 ? entry.layers.slice(0, container + 1) : entry.layers
        if (outer.length) report.format = outer.map((l) => LAYER_NAMES[l]).join(' → ')
        const result = await scanEntry(entry, (stmt) => {
          kept.push(stmt)
          if (/^CREATE\b[^(]*\bTABLE\b/i.test(stmt)) report.tables++
          builder.add(stmt, entry.name)
        })
        if (result.binary) {
          fileNotes.push(`Skipped "${entry.name}": it is not a text file.`)
          continue
        }
        report.entries++
        report.encoding = result.encoding
        report.textBytes += result.textBytes
        for (const k of ['chars', 'statements', 'kept', 'inserts', 'copyBlocks'] as const) report[k] += result.stats[k]
      }
      if (report.entries === 0 && !report.skipped) {
        // Everything inside was skipped: surface the first reason as the file's reason.
        const reason = fileNotes.find((n) => n.startsWith(`Skipped "${name}"`))
        report.skipped = reason ? reason.replace(/^Skipped "[^"]*": /, '').replace(/\.$/, '') : 'it contains no readable SQL text'
        fileNotes.length = 0
      }
    } catch (e) {
      const message =
        e instanceof ArchiveError ? e.message : `it could not be read: ${((e as Error).message || 'the data is truncated or corrupt').replace(/\.+$/, '')}`
      if (report.entries > 0) fileNotes.push(`"${name}" stopped partway: ${message}.`)
      else report.skipped = message
    }

    if (report.skipped) notes.push(`Skipped "${name}": ${report.skipped}.`)
    notes.push(...fileNotes)
    report.ms = performance.now() - started
    reports.push(report)
    ddl.push(kept.join(';\n\n') + (kept.length ? ';\n' : ''))
  }

  const schema = builder.build()
  schema.warnings.unshift(...notes)
  return { schema, files: reports, ddl }
}

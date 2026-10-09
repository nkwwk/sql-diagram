import { SchemaBuilder } from './parser'
import { StatementScanner, type ScanStats } from './scanner'
import type { Schema } from './types'

export interface FileReport extends ScanStats {
  name: string
  /** Size in bytes. */
  size: number
  /** Number of tables created by this file. */
  tables: number
  /** Parse time in milliseconds. */
  ms: number
  encoding: string
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

function detectEncoding(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le'
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be'
  // UTF-16 without BOM: many NUL bytes in the first few characters.
  if (head.length >= 4 && head[1] === 0 && head[3] === 0 && head[0] !== 0) return 'utf-16le'
  return 'utf-8'
}

/**
 * Stream one or more SQL files through the scanner and build a single schema.
 * Only DDL text is retained, so memory stays flat regardless of how much
 * INSERT / COPY data the dumps contain.
 */
export async function importFiles(files: Blob[], onProgress?: (p: ImportProgress) => void): Promise<ImportResult> {
  const builder = new SchemaBuilder()
  const reports: FileReport[] = []
  const ddl: string[] = []

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]
    const name = file instanceof File ? file.name : `file-${fileIndex + 1}.sql`
    const started = performance.now()
    const kept: string[] = []
    let tables = 0
    const scanner = new StatementScanner((stmt) => {
      kept.push(stmt)
      if (/^CREATE\b[^(]*\bTABLE\b/i.test(stmt)) tables++
      builder.add(stmt, name)
    })

    const reader = file.stream().getReader()
    let decoder: TextDecoder | null = null
    let encoding = 'utf-8'
    let loaded = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!decoder) {
        encoding = detectEncoding(value)
        decoder = new TextDecoder(encoding)
      }
      loaded += value.byteLength
      scanner.push(decoder.decode(value, { stream: true }))
      onProgress?.({ fileIndex, fileCount: files.length, name, loaded, total: file.size })
    }
    if (decoder) scanner.push(decoder.decode())
    scanner.end()

    reports.push({ name, size: file.size, tables, ms: performance.now() - started, encoding, ...scanner.stats })
    ddl.push(kept.join(';\n\n') + (kept.length ? ';\n' : ''))
  }

  return { schema: builder.build(), files: reports, ddl }
}

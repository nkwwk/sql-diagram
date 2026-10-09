/*
 * Streaming SQL statement scanner.
 *
 * Feeds arbitrarily sized text chunks through a small state machine and emits
 * only the statements the schema parser cares about (CREATE TABLE, ALTER
 * TABLE, CREATE UNIQUE INDEX, COMMENT ON). Everything else — INSERT data,
 * COPY blocks, procedures — is skipped without being copied, so multi-GB
 * dumps can be scanned with constant memory.
 *
 * Handles: '…' "…" `…` […] quoting (doubled-quote and backslash escapes),
 * PostgreSQL E'…' and $tag$…$tag$ strings, -- / # / block comments,
 * SQL Server GO batch separators, MySQL DELIMITER, PostgreSQL COPY … FROM stdin.
 */

const NORMAL = 0
const LINE_COMMENT = 1
const BLOCK_COMMENT = 2
const QUOTE = 3
const DOLLAR = 4
const COPY_DATA = 5

/** Statements whose text we keep (checked against the first DECIDE_AT chars). */
const KEEP_RE =
  /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|VIRTUAL)\s+)?TABLE\b|ALTER\s+TABLE\b|CREATE\s+UNIQUE\b|COMMENT\s+ON\b|COPY\b|SET\s+standard_conforming_strings\b)/i
const DATA_RE = /^(?:INSERT|REPLACE)\b/i
const GO_RE = /^\s*GO\s*$/i
const DOLLAR_RE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y
const DELIMITER_RE = /^DELIMITER[ \t]+(\S+)/i
/** Dialects where a backslash inside '…' is a literal character (SQL Server, SQLite). */
const NO_BACKSLASH_RE = /^(?:SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER|ANSI_PADDING|NOCOUNT)\b|USE\s+\[|PRAGMA\b)/i

const DECIDE_AT = 256
/** Characters held back at the end of each chunk so look-ahead never crosses a chunk boundary. */
const LOOKAHEAD = 64

export interface ScanStats {
  /** Characters scanned. */
  chars: number
  /** Statements seen (of any kind). */
  statements: number
  /** Statements kept and passed to the parser. */
  kept: number
  /** INSERT / REPLACE statements skipped. */
  inserts: number
  /** PostgreSQL COPY … FROM stdin data blocks skipped. */
  copyBlocks: number
}

export class StatementScanner {
  readonly stats: ScanStats = { chars: 0, statements: 0, kept: 0, inserts: 0, copyBlocks: 0 }

  private readonly emit: (statement: string) => void
  private carry = ''
  private state = NORMAL
  private quoteChar = "'"
  private quoteClose = 39
  private quoteEscapes = false
  private dollarTag = ''
  private inStmt = false
  private keep = false
  private decided = false
  private cur = ''
  private delimiter = ';'
  private delimiterCode = 59
  private backslashEscapes = true
  private copyPending = false
  private onlyWs = true
  /** Text of the current line already consumed in earlier chunks (null once it is too long to be "GO"). */
  private linePrefix: string | null = ''
  /** Char code preceding the next chunk's first character. */
  private prevCode = 10

  constructor(emit: (statement: string) => void) {
    this.emit = emit
  }

  push(chunk: string) {
    this.stats.chars += chunk.length
    this.run(this.carry + chunk, false)
  }

  end() {
    this.run(this.carry, true)
    this.carry = ''
  }

  private decide(head: string) {
    this.decided = true
    const h = head.trimStart()
    if (NO_BACKSLASH_RE.test(h)) this.backslashEscapes = false
    if (KEEP_RE.test(h)) {
      this.keep = true
    } else {
      this.keep = false
      this.cur = ''
      if (DATA_RE.test(h)) this.stats.inserts++
    }
  }

  private finish() {
    if (!this.inStmt) return
    if (!this.decided) this.decide(this.cur)
    if (this.keep) {
      const s = this.cur.trim()
      if (/^COPY\b/i.test(s)) {
        if (/\bFROM\s+STDIN\b/i.test(s)) {
          this.copyPending = true
          this.stats.copyBlocks++
        }
      } else if (/^SET\s+standard_conforming_strings\b/i.test(s)) {
        this.backslashEscapes = !/=\s*'?on'?\s*$/i.test(s) && !/\bTO\s+'?on'?\s*$/i.test(s)
      } else if (s) {
        this.stats.kept++
        this.emit(s)
      }
    }
    this.inStmt = false
    this.keep = false
    this.decided = false
    this.cur = ''
  }

  private run(text: string, final: boolean) {
    const n = text.length
    const limit = final ? n : Math.max(0, n - LOOKAHEAD)
    let i = 0
    let seg = this.inStmt && this.keep ? 0 : -1
    let lineStart = 0
    let linePrefix = this.linePrefix
    let bs = -1
    let stop = false

    const flush = (to: number) => {
      if (seg >= 0) {
        if (to > seg) this.cur += text.slice(seg, to)
        seg = -1
      }
    }
    const resume = (at: number) => {
      if (this.inStmt && this.keep) seg = at
    }

    while (i < limit && !stop) {
      // Decide early whether this statement is worth keeping.
      if (seg >= 0 && !this.decided && this.cur.length + (i - seg) >= DECIDE_AT) {
        const head = this.cur + text.slice(seg, Math.min(i, seg + DECIDE_AT))
        this.decide(head)
        if (this.keep) {
          flush(i)
          seg = i
        } else seg = -1
      }

      switch (this.state) {
        case QUOTE: {
          const j = text.indexOf(this.quoteChar, i)
          if (this.quoteEscapes) {
            if (bs < i) {
              bs = text.indexOf('\\', i)
              if (bs < 0) bs = n
            }
            if (bs < (j < 0 ? n : j) && bs < limit) {
              i = bs + 2
              continue
            }
          }
          if (j < 0 || j >= limit) {
            i = limit
            continue
          }
          if (text.charCodeAt(j + 1) === this.quoteClose) {
            i = j + 2
            continue
          }
          i = j + 1
          this.state = NORMAL
          continue
        }
        case LINE_COMMENT: {
          const j = text.indexOf('\n', i)
          if (j < 0) {
            i = limit
            continue
          }
          i = j
          this.state = NORMAL
          resume(i)
          continue
        }
        case BLOCK_COMMENT: {
          const j = text.indexOf('*/', i)
          if (j < 0) {
            i = limit
            continue
          }
          i = j + 2
          this.state = NORMAL
          resume(i)
          continue
        }
        case DOLLAR: {
          const j = text.indexOf(this.dollarTag, i)
          if (j < 0) {
            i = limit
            continue
          }
          i = j + this.dollarTag.length
          this.state = NORMAL
          continue
        }
        case COPY_DATA: {
          const j = text.indexOf('\n\\.', i)
          if (j < 0) {
            i = limit
            continue
          }
          i = j + 3
          this.state = NORMAL
          continue
        }
      }

      // NORMAL
      const c = text.charCodeAt(i)

      if (c === 10) {
        if (
          this.inStmt &&
          linePrefix !== null &&
          linePrefix.length + i - lineStart <= 16 &&
          GO_RE.test(linePrefix + text.slice(lineStart, i))
        ) {
          flush(lineStart)
          if (linePrefix && this.cur.endsWith(linePrefix)) this.cur = this.cur.slice(0, -linePrefix.length)
          this.finish()
          seg = -1
          this.backslashEscapes = false
        }
        lineStart = i + 1
        linePrefix = ''
        this.onlyWs = true
        i++
        continue
      }
      if (c === 32 || c === 9 || c === 13 || c === 12) {
        i++
        continue
      }

      const next = text.charCodeAt(i + 1)
      // Comments
      if ((c === 45 && next === 45) || (c === 35 && this.onlyWs)) {
        flush(i)
        if (this.inStmt && this.keep) this.cur += ' '
        this.state = LINE_COMMENT
        i += c === 35 ? 1 : 2
        continue
      }
      if (c === 47 && next === 42) {
        flush(i)
        if (this.inStmt && this.keep) this.cur += ' '
        this.state = BLOCK_COMMENT
        i += 2
        continue
      }
      this.onlyWs = false

      if (!this.inStmt) {
        // MySQL client directive: DELIMITER <token> (ends at the newline)
        if ((c === 68 || c === 100) && DELIMITER_RE.test(text.slice(i, i + 40))) {
          const nl = text.indexOf('\n', i)
          if (nl < 0 && !final) {
            stop = true
            break
          }
          const line = text.slice(i, nl < 0 ? n : nl)
          this.delimiter = DELIMITER_RE.exec(line)![1]
          this.delimiterCode = this.delimiter.charCodeAt(0)
          i = nl < 0 ? n : nl
          continue
        }
        this.inStmt = true
        this.keep = true
        this.decided = false
        this.cur = ''
        this.stats.statements++
        seg = i
      }

      if (c === 39 || c === 34 || c === 96 || c === 91) {
        this.quoteChar = c === 91 ? ']' : text[i]
        this.quoteClose = this.quoteChar.charCodeAt(0)
        const prev = i > 0 ? text.charCodeAt(i - 1) : this.prevCode
        const eString = c === 39 && (prev === 69 || prev === 101)
        this.quoteEscapes = (c === 39 || c === 34) && (this.backslashEscapes || eString)
        this.state = QUOTE
        i++
        continue
      }
      if (c === 36 && this.delimiter[0] !== '$') {
        DOLLAR_RE.lastIndex = i
        const m = DOLLAR_RE.exec(text)
        if (m) {
          this.dollarTag = m[0]
          this.state = DOLLAR
          i += m[0].length
          continue
        }
      }
      if (c === this.delimiterCode && (this.delimiter.length === 1 || text.startsWith(this.delimiter, i))) {
        flush(i)
        this.finish()
        seg = -1
        i += this.delimiter.length
        if (this.copyPending) {
          this.copyPending = false
          this.state = COPY_DATA
        }
        continue
      }
      i++
    }

    flush(i)
    if (final) {
      this.finish()
      this.carry = ''
    } else {
      const tail = Math.max(0, i - lineStart)
      this.linePrefix = linePrefix === null || linePrefix.length + tail > 16 ? null : linePrefix + text.slice(lineStart, i)
      if (i > 0) this.prevCode = text.charCodeAt(i - 1)
      this.carry = text.slice(i)
    }
  }
}

/** Convenience: scan a whole string and return the kept statements. */
export function scanStatements(sql: string): { statements: string[]; stats: ScanStats } {
  const statements: string[] = []
  const scanner = new StatementScanner((s) => statements.push(s))
  scanner.push(sql)
  scanner.end()
  return { statements, stats: scanner.stats }
}

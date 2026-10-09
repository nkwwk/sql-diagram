/*
 * Streaming bzip2 decompressor.
 *
 * bzip2 compresses independent blocks (≤ 900 kB each), so memory stays bounded:
 * input is buffered until a whole block can be decoded, the block is inverted
 * (Huffman → MTF → BWT → RLE) and emitted, and its input is discarded.
 * Supports concatenated streams (pbzip2/lbzip2 output) and verifies CRCs.
 */

const NEED_MORE = Symbol('need-more')

/** Try to decode a block once at least this much input is buffered (or the input has ended). */
const ATTEMPT_BYTES = 1 << 20

const RUNA = 0
const RUNB = 1
const MAX_GROUPS = 6
const MAX_CODE_LEN = 20
const GROUP_SIZE = 50

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
    t[i] = c >>> 0
  }
  return t
})()

interface HuffmanTable {
  minLen: number
  limit: Int32Array
  base: Int32Array
  perm: Int32Array
}

export class Bunzip2 {
  private readonly onData: (chunk: Uint8Array) => void
  private buf = new Uint8Array(0)
  private len = 0
  private pos = 0
  private bitBuf = 0
  private bitCount = 0
  private final = false
  private state: 'header' | 'block' | 'done' = 'header'
  private blockMax = 0
  private tt = new Uint32Array(0)
  private streamCrc = 0
  private streams = 0
  private minAvail = 4

  constructor(onData: (chunk: Uint8Array) => void) {
    this.onData = onData
  }

  push(chunk: Uint8Array, final = false) {
    this.append(chunk)
    this.final = final
    this.run()
  }

  private append(chunk: Uint8Array) {
    if (this.pos > 0) {
      this.buf.copyWithin(0, this.pos, this.len)
      this.len -= this.pos
      this.pos = 0
    }
    if (this.len + chunk.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length, 1 << 16))
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
    }
    this.buf.set(chunk, this.len)
    this.len += chunk.length
  }

  private run() {
    for (;;) {
      if (this.state === 'done') return
      const avail = this.len - this.pos + (this.bitCount >> 3)
      if (!this.final && avail < this.minAvail) return
      const saved = [this.pos, this.bitBuf, this.bitCount] as const
      try {
        if (this.state === 'header') {
          if (this.final && this.len - this.pos === 0 && this.bitCount === 0) {
            if (this.streams === 0) throw new Error('Empty bzip2 input')
            this.state = 'done'
            return
          }
          if (!this.readHeader()) {
            // Not another stream: ignore trailing padding/garbage after a complete stream.
            this.state = 'done'
            return
          }
          this.state = 'block'
          this.minAvail = ATTEMPT_BYTES
        } else if (!this.readBlock()) {
          this.state = 'header'
          this.minAvail = 4
        } else {
          this.minAvail = ATTEMPT_BYTES
        }
      } catch (e) {
        if (e !== NEED_MORE) throw e
        ;[this.pos, this.bitBuf, this.bitCount] = saved
        if (this.final) throw new Error('Unexpected end of bzip2 data')
        this.minAvail = Math.max(this.minAvail, avail * 2)
        return
      }
    }
  }

  private bits(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.len) throw NEED_MORE
      this.bitBuf = (this.bitBuf << 8) | this.buf[this.pos++]
      this.bitCount += 8
    }
    this.bitCount -= n
    return (this.bitBuf >>> this.bitCount) & ((1 << n) - 1)
  }

  private bits32(): number {
    return ((this.bits(16) << 16) | this.bits(16)) >>> 0
  }

  /** Reads "BZh1".."BZh9". Returns false if the next bytes are not a stream header. */
  private readHeader(): boolean {
    this.alignToByte()
    if (this.len - this.pos < 4) {
      if (this.final) return false
      throw NEED_MORE
    }
    const b = this.buf
    const p = this.pos
    const level = b[p + 3] - 48
    if (b[p] !== 0x42 || b[p + 1] !== 0x5a || b[p + 2] !== 0x68 || level < 1 || level > 9) {
      if (this.streams === 0) throw new Error('Not a bzip2 stream')
      return false
    }
    this.pos += 4
    this.blockMax = level * 100000
    if (this.tt.length < this.blockMax) this.tt = new Uint32Array(this.blockMax)
    this.streamCrc = 0
    this.streams++
    return true
  }

  private alignToByte() {
    // Return any whole unread bytes held in the bit buffer to the byte stream.
    this.bitCount -= this.bitCount & 7
    this.pos -= this.bitCount >> 3
    this.bitCount = 0
    this.bitBuf = 0
  }

  /** Decodes one block and emits its output. Returns false at the end-of-stream marker. */
  private readBlock(): boolean {
    const m1 = this.bits(24)
    const m2 = this.bits(24)
    if (m1 === 0x177245 && m2 === 0x385090) {
      const crc = this.bits32()
      if (crc !== this.streamCrc) throw new Error('bzip2 stream CRC mismatch')
      this.alignToByte()
      return false
    }
    if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('Invalid bzip2 block header')
    const blockCrc = this.bits32()
    if (this.bits(1)) throw new Error('Randomised bzip2 blocks are not supported')
    const origPtr = this.bits(24)

    // Symbol map: which byte values occur in the block.
    const seqToUnseq = new Uint8Array(256)
    let nInUse = 0
    const used16 = this.bits(16)
    for (let i = 0; i < 16; i++) {
      if (!(used16 & (0x8000 >> i))) continue
      const bits = this.bits(16)
      for (let j = 0; j < 16; j++) if (bits & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j
    }
    if (nInUse === 0) throw new Error('Corrupt bzip2 block (no symbols)')
    const alphaSize = nInUse + 2
    const EOB = nInUse + 1

    // Huffman group selectors (MTF coded).
    const nGroups = this.bits(3)
    const nSelectors = this.bits(15)
    if (nGroups < 2 || nGroups > MAX_GROUPS || nSelectors < 1) throw new Error('Corrupt bzip2 block (selectors)')
    const mtfGroups = Array.from({ length: nGroups }, (_, i) => i)
    const selectors = new Uint8Array(nSelectors)
    for (let i = 0; i < nSelectors; i++) {
      let j = 0
      while (this.bits(1)) if (++j >= nGroups) throw new Error('Corrupt bzip2 block (selector)')
      const v = mtfGroups[j]
      mtfGroups.splice(j, 1)
      mtfGroups.unshift(v)
      selectors[i] = v
    }

    // Code lengths (delta coded) and decode tables.
    const tables: HuffmanTable[] = []
    const lens = new Uint8Array(alphaSize)
    for (let t = 0; t < nGroups; t++) {
      let curr = this.bits(5)
      for (let i = 0; i < alphaSize; i++) {
        for (;;) {
          if (curr < 1 || curr > MAX_CODE_LEN) throw new Error('Corrupt bzip2 block (code length)')
          if (!this.bits(1)) break
          curr += this.bits(1) ? -1 : 1
        }
        lens[i] = curr
      }
      tables.push(buildTable(lens, alphaSize))
    }

    // Huffman + RUNA/RUNB + MTF decode into tt, counting byte frequencies.
    const tt = this.tt
    const counts = new Int32Array(256)
    const yy = new Uint8Array(256)
    for (let i = 0; i < 256; i++) yy[i] = i
    let nblock = 0
    let groupIndex = -1
    let groupLeft = 0
    let table = tables[0]
    let runLength = 0
    let runWeight = 1
    for (;;) {
      if (groupLeft === 0) {
        if (++groupIndex >= nSelectors) throw new Error('Corrupt bzip2 block (selector overflow)')
        groupLeft = GROUP_SIZE
        table = tables[selectors[groupIndex]]
      }
      groupLeft--
      let zn = table.minLen
      let zvec = this.bits(zn)
      while (zvec > table.limit[zn]) {
        if (++zn > MAX_CODE_LEN) throw new Error('Corrupt bzip2 block (code)')
        zvec = (zvec << 1) | this.bits(1)
      }
      const index = zvec - table.base[zn]
      if (index < 0 || index >= alphaSize) throw new Error('Corrupt bzip2 block (symbol)')
      const sym = table.perm[index]

      if (sym === RUNA || sym === RUNB) {
        runLength += (sym === RUNA ? 1 : 2) * runWeight
        runWeight <<= 1
        if (runLength > this.blockMax) throw new Error('Corrupt bzip2 block (run)')
        continue
      }
      if (runLength > 0) {
        if (nblock + runLength > this.blockMax) throw new Error('Corrupt bzip2 block (overflow)')
        const b = seqToUnseq[yy[0]]
        counts[b] += runLength
        tt.fill(b, nblock, nblock + runLength)
        nblock += runLength
        runLength = 0
        runWeight = 1
      }
      if (sym === EOB) break
      if (nblock >= this.blockMax) throw new Error('Corrupt bzip2 block (overflow)')
      const idx = sym - 1
      const uc = yy[idx]
      yy.copyWithin(1, 0, idx)
      yy[0] = uc
      const b = seqToUnseq[uc]
      counts[b]++
      tt[nblock++] = b
    }
    if (origPtr >= nblock) throw new Error('Corrupt bzip2 block (origin)')

    // All input for this block has been read; from here on nothing can throw NEED_MORE.
    // Inverse Burrows–Wheeler transform.
    const cftab = new Int32Array(256)
    for (let i = 1; i < 256; i++) cftab[i] = cftab[i - 1] + counts[i - 1]
    for (let i = 0; i < nblock; i++) {
      const b = tt[i] & 0xff
      tt[cftab[b]++] |= i << 8
    }

    // Walk the BWT chain, undoing the initial run-length encoding, computing the CRC.
    let out = new Uint8Array(nblock + (nblock >> 2) + 64)
    let o = 0
    let crc = 0xffffffff
    let tPos = tt[origPtr] >>> 8
    let last = -1
    let run = 0
    const put = (byte: number) => {
      if (o >= out.length) {
        const bigger = new Uint8Array(out.length * 2)
        bigger.set(out)
        out = bigger
      }
      out[o++] = byte
      crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]
    }
    for (let k = 0; k < nblock; k++) {
      const e = tt[tPos]
      const ch = e & 0xff
      tPos = e >>> 8
      if (run === 4) {
        for (let r = 0; r < ch; r++) put(last)
        run = 0
        continue
      }
      if (ch === last) run++
      else {
        last = ch
        run = 1
      }
      put(ch)
    }
    if (~crc >>> 0 !== blockCrc) throw new Error('bzip2 block CRC mismatch')
    this.streamCrc = (((this.streamCrc << 1) | (this.streamCrc >>> 31)) ^ blockCrc) >>> 0
    this.onData(out.subarray(0, o))
    return true
  }
}

function buildTable(lens: Uint8Array, alphaSize: number): HuffmanTable {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i++) {
    minLen = Math.min(minLen, lens[i])
    maxLen = Math.max(maxLen, lens[i])
  }
  const perm = new Int32Array(alphaSize)
  let pp = 0
  for (let len = minLen; len <= maxLen; len++) for (let j = 0; j < alphaSize; j++) if (lens[j] === len) perm[pp++] = j
  const base = new Int32Array(MAX_CODE_LEN + 2)
  for (let i = 0; i < alphaSize; i++) base[lens[i] + 1]++
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1]
  const limit = new Int32Array(MAX_CODE_LEN + 1).fill(-1)
  let vec = 0
  for (let i = minLen; i <= maxLen; i++) {
    vec += base[i + 1] - base[i]
    limit[i] = vec - 1
    vec <<= 1
  }
  for (let i = minLen + 1; i <= maxLen; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i]
  return { minLen, limit, base, perm }
}


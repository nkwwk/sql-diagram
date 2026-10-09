/*
 * Decryption for password-protected zip entries:
 *
 *  - Traditional PKWARE encryption ("ZipCrypto"), as written by `zip -P`.
 *  - WinZip AES (AE-1 / AE-2, 128/192/256-bit): PBKDF2-HMAC-SHA1 key derivation
 *    (WebCrypto) and AES in CTR mode with WinZip's little-endian counter, which
 *    WebCrypto's big-endian AES-CTR cannot express — hence the small AES below.
 */

// ---------------------------------------------------------------------------
// CRC-32 (zip polynomial, reflected)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

const crcByte = (crc: number, b: number) => (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0

/** Streaming CRC-32. */
export class Crc32 {
  private c = 0xffffffff
  update(data: Uint8Array) {
    let c = this.c
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
    this.c = c
  }
  get value() {
    return (this.c ^ 0xffffffff) >>> 0
  }
}

// ---------------------------------------------------------------------------
// ZipCrypto

export class ZipCryptoDecryptor {
  private k0 = 0x12345678
  private k1 = 0x23456789
  private k2 = 0x34567890

  constructor(password: Uint8Array) {
    for (const b of password) this.update(b)
  }

  private update(b: number) {
    this.k0 = crcByte(this.k0, b)
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0
    this.k2 = crcByte(this.k2, this.k1 >>> 24)
  }

  /** Decrypts in place and returns the same array. */
  decrypt(data: Uint8Array): Uint8Array {
    for (let i = 0; i < data.length; i++) {
      const t = (this.k2 | 2) & 0xffff
      const p = data[i] ^ ((Math.imul(t, t ^ 1) >>> 8) & 0xff)
      data[i] = p
      this.update(p)
    }
    return data
  }
}

/**
 * Checks a password against the 12-byte encryption header. Returns a decryptor positioned
 * after the header, or null when the check byte does not match (wrong password).
 * The check byte is the CRC's high byte, or the DOS time's high byte when a data descriptor is used.
 */
export function openZipCrypto(password: string, header: Uint8Array, crc: number, dosTime: number): ZipCryptoDecryptor | null {
  const d = new ZipCryptoDecryptor(new TextEncoder().encode(password))
  const plain = d.decrypt(header.slice(0, 12))
  const check = plain[11]
  return check === crc >>> 24 || check === ((dosTime >>> 8) & 0xff) ? d : null
}

// ---------------------------------------------------------------------------
// AES (encryption direction only — CTR mode needs nothing else)

const SBOX = new Uint8Array(256)
const T0 = new Uint32Array(256)
const T1 = new Uint32Array(256)
const T2 = new Uint32Array(256)
const T3 = new Uint32Array(256)
;(() => {
  // Build the S-box from GF(2^8) inverses, then the combined SubBytes/MixColumns tables.
  const exp = new Uint8Array(256)
  const log = new Uint8Array(256)
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0)
  }
  for (let i = 0; i < 256; i++) {
    let inv = i === 0 ? 0 : exp[(255 - log[i]) % 255]
    let s = inv
    for (let k = 0; k < 4; k++) {
      inv = ((inv << 1) | (inv >>> 7)) & 0xff
      s ^= inv
    }
    SBOX[i] = s ^ 0x63
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i]
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x11b : 0)) & 0xff
    const s3 = s2 ^ s
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0
    T0[i] = t
    T1[i] = ((t >>> 8) | (t << 24)) >>> 0
    T2[i] = ((t >>> 16) | (t << 16)) >>> 0
    T3[i] = ((t >>> 24) | (t << 8)) >>> 0
  }
})()

export class Aes {
  private readonly w: Uint32Array
  private readonly rounds: number

  constructor(key: Uint8Array) {
    const nk = key.length / 4
    if (![4, 6, 8].includes(nk)) throw new Error('AES key must be 16, 24 or 32 bytes')
    this.rounds = nk + 6
    const w = new Uint32Array(4 * (this.rounds + 1))
    for (let i = 0; i < nk; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0
    let rcon = 1
    for (let i = nk; i < w.length; i++) {
      let t = w[i - 1]
      if (i % nk === 0) {
        t = ((SBOX[(t >>> 16) & 0xff] << 24) | (SBOX[(t >>> 8) & 0xff] << 16) | (SBOX[t & 0xff] << 8) | SBOX[t >>> 24]) ^ (rcon << 24)
        rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff
      } else if (nk > 6 && i % nk === 4) {
        t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]
      }
      w[i] = (w[i - nk] ^ t) >>> 0
    }
    this.w = w
  }

  /** Encrypts one 16-byte block from `input` into `out` (may alias). */
  encryptBlock(input: Uint8Array, out: Uint8Array) {
    const w = this.w
    let s0 = ((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) ^ w[0]
    let s1 = ((input[4] << 24) | (input[5] << 16) | (input[6] << 8) | input[7]) ^ w[1]
    let s2 = ((input[8] << 24) | (input[9] << 16) | (input[10] << 8) | input[11]) ^ w[2]
    let s3 = ((input[12] << 24) | (input[13] << 16) | (input[14] << 8) | input[15]) ^ w[3]
    let k = 4
    for (let r = 1; r < this.rounds; r++) {
      const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k++]
      const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k++]
      const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k++]
      const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k++]
      s0 = t0
      s1 = t1
      s2 = t2
      s3 = t3
    }
    const last = (a: number, b: number, c: number, d: number, key: number) =>
      ((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff]) ^ key
    const o0 = last(s0, s1, s2, s3, w[k])
    const o1 = last(s1, s2, s3, s0, w[k + 1])
    const o2 = last(s2, s3, s0, s1, w[k + 2])
    const o3 = last(s3, s0, s1, s2, w[k + 3])
    for (const [i, v] of [o0, o1, o2, o3].entries()) {
      out[4 * i] = v >>> 24
      out[4 * i + 1] = v >>> 16
      out[4 * i + 2] = v >>> 8
      out[4 * i + 3] = v
    }
  }
}

/** WinZip AES-CTR: 16-byte little-endian counter starting at 1. Encryption and decryption are identical. */
export class WinZipAesCtr {
  private readonly aes: Aes
  private readonly counter = new Uint8Array(16)
  private readonly stream = new Uint8Array(16)
  private used = 16

  constructor(key: Uint8Array) {
    this.aes = new Aes(key)
  }

  /** XORs `data` with the key stream, in place. */
  apply(data: Uint8Array): Uint8Array {
    for (let i = 0; i < data.length; i++) {
      if (this.used === 16) {
        for (let j = 0; j < 16 && ++this.counter[j] === 0; j++);
        this.aes.encryptBlock(this.counter, this.stream)
        this.used = 0
      }
      data[i] ^= this.stream[this.used++]
    }
    return data
  }
}

export const AES_SALT_LENGTH: Record<number, number> = { 1: 8, 2: 12, 3: 16 }
const AES_KEY_LENGTH: Record<number, number> = { 1: 16, 2: 24, 3: 32 }

/**
 * Derives the WinZip AES keys and checks the 2-byte password verifier.
 * Returns the CTR decryptor, or null for a wrong password.
 */
export async function openWinZipAes(password: string, strength: number, salt: Uint8Array, verifier: Uint8Array): Promise<WinZipAesCtr | null> {
  const keyLen = AES_KEY_LENGTH[strength]
  if (!keyLen) throw new Error(`unknown AES strength ${strength}`)
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt: new Uint8Array(salt), iterations: 1000 }, material, (2 * keyLen + 2) * 8),
  )
  if (bits[2 * keyLen] !== verifier[0] || bits[2 * keyLen + 1] !== verifier[1]) return null
  return new WinZipAesCtr(bits.subarray(0, keyLen))
}

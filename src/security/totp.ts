import { createHmac, randomBytes } from "node:crypto"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export const base32Encode = (buf: Uint8Array): string => {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export const base32Decode = (s: string): Uint8Array => {
  const clean = s.replace(/=+$/, "").toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error("Invalid base32 character")
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export const generateSecret = (): string => base32Encode(randomBytes(20))

const hotp = (secret: string, counter: bigint, digits = 6): string => {
  const key = base32Decode(secret)
  const buf = new ArrayBuffer(8)
  new DataView(buf).setBigUint64(0, counter)
  const mac = createHmac("sha1", key).update(new Uint8Array(buf)).digest()
  const offset = mac[mac.length - 1]! & 0xf
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff)
  return (code % 10 ** digits).toString().padStart(digits, "0")
}

export const totpAt = (secret: string, when: Date = new Date(), step = 30): string =>
  hotp(secret, BigInt(Math.floor(when.getTime() / 1000 / step)))

export const verifyTotp = (
  secret: string,
  code: string,
  opts: { when?: Date; step?: number; window?: number } = {},
): boolean => {
  const cleaned = code.replace(/\s+/g, "")
  if (!/^\d{6}$/.test(cleaned)) return false
  const now = opts.when ?? new Date()
  const step = opts.step ?? 30
  const window = opts.window ?? 1
  const counter = Math.floor(now.getTime() / 1000 / step)
  for (let i = -window; i <= window; i++) {
    if (hotp(secret, BigInt(counter + i)) === cleaned) return true
  }
  return false
}

export const otpauthUrl = (opts: {
  secret: string
  account: string
  issuer: string
  digits?: number
  period?: number
}): string => {
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(opts.digits ?? 6),
    period: String(opts.period ?? 30),
  })
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`
  return `otpauth://totp/${label}?${params.toString()}`
}

export const generateBackupCodes = (count = 10): string[] => {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const buf = randomBytes(5)
    const hex = Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("")
    codes.push(`${hex.slice(0, 5)}-${hex.slice(5)}`)
  }
  return codes
}

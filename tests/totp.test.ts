import { describe, expect, test } from "bun:test"
import {
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateSecret,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from "../src/security/totp.ts"

// RFC 6238 reference vectors use the SHA-1 secret "12345678901234567890" (20 bytes).
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"))

describe("base32", () => {
  test("encode/decode round-trip", () => {
    const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])
    const encoded = base32Encode(buf)
    const decoded = base32Decode(encoded)
    expect([...decoded]).toEqual([...buf])
  })

  test("decoding handles lowercase + padding", () => {
    const buf = new Uint8Array([0x4d, 0x61, 0x6e])
    expect([...base32Decode(base32Encode(buf).toLowerCase())]).toEqual([...buf])
  })
})

describe("totp", () => {
  // RFC 6238 Appendix B test vectors (SHA-1, 30s step, 8-digit codes are listed but
  // we use 6-digit so we compare to the truncated suffix).
  const cases: Array<{ unix: number; expected6: string }> = [
    { unix: 59, expected6: "287082" },
    { unix: 1111111109, expected6: "081804" },
    { unix: 1111111111, expected6: "050471" },
    { unix: 1234567890, expected6: "005924" },
    { unix: 2000000000, expected6: "279037" },
  ]

  for (const c of cases) {
    test(`matches RFC 6238 vector at t=${c.unix}`, () => {
      const got = totpAt(RFC_SECRET, new Date(c.unix * 1000))
      expect(got).toBe(c.expected6)
    })
  }

  test("verify accepts current code", () => {
    const at = new Date(1234567890 * 1000)
    expect(verifyTotp(RFC_SECRET, "005924", { when: at })).toBe(true)
  })

  test("verify accepts ±1 window for clock drift", () => {
    const now = new Date(2_000_000_000 * 1000)
    const before = totpAt(RFC_SECRET, new Date(now.getTime() - 30_000))
    const after = totpAt(RFC_SECRET, new Date(now.getTime() + 30_000))
    expect(verifyTotp(RFC_SECRET, before, { when: now })).toBe(true)
    expect(verifyTotp(RFC_SECRET, after, { when: now })).toBe(true)
  })

  test("verify rejects code outside window", () => {
    const now = new Date(2_000_000_000 * 1000)
    const tooOld = totpAt(RFC_SECRET, new Date(now.getTime() - 5 * 60_000))
    expect(verifyTotp(RFC_SECRET, tooOld, { when: now })).toBe(false)
  })

  test("verify rejects malformed inputs", () => {
    expect(verifyTotp(RFC_SECRET, "abc")).toBe(false)
    expect(verifyTotp(RFC_SECRET, "12345")).toBe(false)
    expect(verifyTotp(RFC_SECRET, "1234567")).toBe(false)
  })
})

describe("backup codes", () => {
  test("generates the requested count", () => {
    expect(generateBackupCodes(5)).toHaveLength(5)
    expect(generateBackupCodes(10)).toHaveLength(10)
  })

  test("codes follow xxxxx-xxxxx hex shape", () => {
    for (const c of generateBackupCodes(20)) {
      expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/)
    }
  })

  test("codes are unique within a batch", () => {
    const codes = generateBackupCodes(20)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe("secret + otpauth url", () => {
  test("generated secret is base32 with reasonable length", () => {
    const s = generateSecret()
    expect(s).toMatch(/^[A-Z2-7]+$/)
    expect(s.length).toBeGreaterThanOrEqual(30)
  })

  test("otpauth url has issuer + secret", () => {
    const url = otpauthUrl({ secret: "JBSWY3DPEHPK3PXP", account: "alice@example.com", issuer: "Stohr" })
    expect(url).toMatch(/^otpauth:\/\/totp\/Stohr:alice%40example\.com\?/)
    expect(url).toContain("issuer=Stohr")
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP")
    expect(url).toContain("algorithm=SHA1")
    expect(url).toContain("digits=6")
    expect(url).toContain("period=30")
  })
})

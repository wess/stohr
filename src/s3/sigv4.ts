import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export type SigInfo = {
  accessKey: string
  scope: string
  signedHeaders: string[]
  signature: string
  date: string
  region: string
  service: string
}

const sha256hex = (data: string | Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex")

const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest()

export const parseAuthHeader = (header: string): SigInfo | null => {
  if (!header.startsWith("AWS4-HMAC-SHA256 ")) return null
  const rest = header.slice("AWS4-HMAC-SHA256 ".length).trim()
  const parts: Record<string, string> = {}
  for (const segment of rest.split(",")) {
    const trimmed = segment.trim()
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    parts[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  const cred = parts.Credential
  const signed = parts.SignedHeaders
  const sig = parts.Signature
  if (!cred || !signed || !sig) return null
  const credParts = cred.split("/")
  if (credParts.length !== 5) return null
  return {
    accessKey: credParts[0]!,
    date: credParts[1]!,
    region: credParts[2]!,
    service: credParts[3]!,
    scope: credParts.slice(1).join("/"),
    signedHeaders: signed.split(";"),
    signature: sig,
  }
}

const RFC3986_UNRESERVED = /^[A-Za-z0-9\-._~]$/

const encodeURIComponentRFC3986 = (s: string): string => {
  let out = ""
  for (const ch of s) {
    if (RFC3986_UNRESERVED.test(ch)) out += ch
    else out += encodeURIComponent(ch).replace(/[!*'()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  }
  return out
}

export const canonicalPath = (rawPath: string): string => {
  return rawPath.split("/").map(encodeURIComponentRFC3986).join("/")
}

export const canonicalQuery = (search: string): string => {
  if (!search || search === "?") return ""
  const qs = search.startsWith("?") ? search.slice(1) : search
  if (!qs) return ""
  const pairs = qs.split("&").map(pair => {
    const eq = pair.indexOf("=")
    const k = eq < 0 ? pair : pair.slice(0, eq)
    const v = eq < 0 ? "" : pair.slice(eq + 1)
    return [encodeURIComponentRFC3986(decodeURIComponent(k)), encodeURIComponentRFC3986(decodeURIComponent(v))] as const
  })
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  return pairs.map(([k, v]) => `${k}=${v}`).join("&")
}

export type VerifyInput = {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  payloadHash: string
  secretKey: string
  sig: SigInfo
  amzDate: string
}

export const computeSignature = (input: VerifyInput): string => {
  const canonicalHeaders = input.sig.signedHeaders
    .map(h => {
      const v = input.headers[h.toLowerCase()] ?? ""
      return `${h.toLowerCase()}:${v.trim().replace(/\s+/g, " ")}\n`
    })
    .join("")
  const signedHeaderList = input.sig.signedHeaders.join(";")
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.path),
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaderList,
    input.payloadHash,
  ].join("\n")

  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, input.sig.scope, sha256hex(canonicalRequest)].join("\n")

  const kDate = hmac(`AWS4${input.secretKey}`, input.sig.date)
  const kRegion = hmac(kDate, input.sig.region)
  const kService = hmac(kRegion, input.sig.service)
  const kSigning = hmac(kService, "aws4_request")
  return createHmac("sha256", kSigning).update(stringToSign).digest("hex")
}

export const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

export const sha256OfBytes = (bytes: Uint8Array): string => sha256hex(bytes)

// x-amz-date is ISO 8601 basic: 20260102T030405Z. Returns epoch ms, or null
// when the header is not in that shape.
export const parseAmzDate = (value: string): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  return Number.isFinite(t) ? t : null
}

// AWS rejects requests whose signing time is more than 15 minutes off the
// server clock; a captured request is otherwise replayable for as long as the
// key lives.
export const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
export const PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/

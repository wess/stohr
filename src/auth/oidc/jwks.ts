// Minimal JWKS-backed ID token verification using SubtleCrypto. Supports
// RS256 / RS384 / RS512 + ES256 / ES384 — covers every common IdP. The JWKS
// is cached per issuer for an hour; on a kid miss we refetch once before
// rejecting the token to handle mid-rotation.

type JwkRsa = {
  kty: "RSA"
  kid?: string
  alg?: string
  n: string
  e: string
}

type JwkEc = {
  kty: "EC"
  kid?: string
  alg?: string
  crv: "P-256" | "P-384"
  x: string
  y: string
}

type Jwk = JwkRsa | JwkEc

type Jwks = { keys: Jwk[] }

type Cached = { value: Jwks; expiresAt: number }

const TTL_MS = 60 * 60 * 1000

const jwksCache = new Map<string, Cached>()

const fetchJwks = async (jwksUri: string, force: boolean): Promise<Jwks> => {
  if (!force) {
    const hit = jwksCache.get(jwksUri)
    if (hit && hit.expiresAt > Date.now()) return hit.value
  }
  const res = await fetch(jwksUri, { headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const value = (await res.json()) as Jwks
  jwksCache.set(jwksUri, { value, expiresAt: Date.now() + TTL_MS })
  return value
}

const b64uToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad)
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const out = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const b64uToText = (s: string): string => new TextDecoder().decode(b64uToBytes(s))

const importKey = async (jwk: Jwk, alg: string): Promise<CryptoKey> => {
  if (jwk.kty === "RSA") {
    const hash = alg === "RS256" ? "SHA-256" : alg === "RS384" ? "SHA-384" : "SHA-512"
    return crypto.subtle.importKey("jwk", jwk as unknown as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash }, false, [
      "verify",
    ])
  }
  const hash = alg === "ES256" ? "SHA-256" : "SHA-384"
  const namedCurve = jwk.crv
  return crypto.subtle.importKey("jwk", jwk as unknown as JsonWebKey, { name: "ECDSA", namedCurve, hash }, false, [
    "verify",
  ])
}

const algParams = (alg: string): AlgorithmIdentifier => {
  if (alg.startsWith("RS")) return { name: "RSASSA-PKCS1-v1_5" }
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" } as EcdsaParams
  if (alg === "ES384") return { name: "ECDSA", hash: "SHA-384" } as EcdsaParams
  throw new Error(`Unsupported alg: ${alg}`)
}

export type IdTokenClaims = {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  [k: string]: unknown
}

export type VerifyResult = {
  claims: IdTokenClaims
  raw: string
}

const splitJwt = (jwt: string): { header: string; payload: string; signature: string } => {
  const parts = jwt.split(".")
  if (parts.length !== 3) throw new Error("Malformed JWT")
  return { header: parts[0]!, payload: parts[1]!, signature: parts[2]! }
}

const findKey = (jwks: Jwks, kid: string | undefined, alg: string): Jwk | null => {
  if (kid) {
    const exact = jwks.keys.find(k => k.kid === kid)
    if (exact) return exact
  }
  return jwks.keys.find(k => k.alg === alg) ?? jwks.keys[0] ?? null
}

export const verifyIdToken = async (
  idToken: string,
  opts: { jwksUri: string; issuer: string; clientId: string; nonce?: string; clockSkewSec?: number },
): Promise<VerifyResult> => {
  const { header, payload, signature } = splitJwt(idToken)
  const headerObj = JSON.parse(b64uToText(header)) as { alg: string; kid?: string; typ?: string }
  if (!headerObj.alg) throw new Error("ID token missing alg")
  if (!["RS256", "RS384", "RS512", "ES256", "ES384"].includes(headerObj.alg)) {
    throw new Error(`Unsupported alg: ${headerObj.alg}`)
  }

  let jwks = await fetchJwks(opts.jwksUri, false)
  let key = findKey(jwks, headerObj.kid, headerObj.alg)
  if (!key) {
    jwks = await fetchJwks(opts.jwksUri, true)
    key = findKey(jwks, headerObj.kid, headerObj.alg)
  }
  if (!key) throw new Error("No matching JWK")

  const cryptoKey = await importKey(key, headerObj.alg)
  const data = new TextEncoder().encode(`${header}.${payload}`)
  const sig = b64uToBytes(signature)
  // Cast to BufferSource — Uint8Array<ArrayBuffer> is structurally fine for
  // SubtleCrypto but TS narrows it to ArrayBufferView<ArrayBuffer> which has
  // a stricter buffer type than what some lib-dom versions emit here.
  const ok = await crypto.subtle.verify(algParams(headerObj.alg), cryptoKey, sig as BufferSource, data as BufferSource)
  if (!ok) throw new Error("ID token signature failed")

  const claims = JSON.parse(b64uToText(payload)) as IdTokenClaims
  const skew = opts.clockSkewSec ?? 60
  const now = Math.floor(Date.now() / 1000)
  if (claims.exp + skew < now) throw new Error("ID token expired")
  if (claims.iat - skew > now) throw new Error("ID token issued in the future")
  if (claims.iss !== opts.issuer) throw new Error(`ID token iss mismatch: ${claims.iss}`)
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(opts.clientId)) throw new Error("ID token aud mismatch")
  if (opts.nonce && claims.nonce !== opts.nonce) throw new Error("ID token nonce mismatch")
  if (!claims.sub) throw new Error("ID token missing sub")

  return { claims, raw: idToken }
}

export const clearJwksCache = (): void => {
  jwksCache.clear()
}

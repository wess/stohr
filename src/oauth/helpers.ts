import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export const SUPPORTED_SCOPES = ["read", "write", "share"] as const
export type Scope = typeof SUPPORTED_SCOPES[number]

export const isScope = (s: string): s is Scope => (SUPPORTED_SCOPES as readonly string[]).includes(s)

/** Spec-compliant base64url encoding (no padding, +/_-). */
const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

/** Random URL-safe identifier (used for client_id, codes, tokens). */
export const randomId = (bytes = 32): string => b64url(randomBytes(bytes))

/** Random short identifier (used for client_id only — easier to display). */
export const shortId = (): string => `cli_${randomBytes(12).toString("hex")}`

/** Verify a PKCE S256 challenge against the verifier the client sends back. */
export const verifyPkceS256 = (verifier: string, challenge: string): boolean => {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) return false
  const hashed = b64url(createHash("sha256").update(verifier).digest())
  // Constant-time string compare.
  if (hashed.length !== challenge.length) return false
  try {
    return timingSafeEqual(Buffer.from(hashed), Buffer.from(challenge))
  } catch {
    return false
  }
}

/** Hash an opaque token for storage (refresh tokens, client secrets). */
export const sha256 = (input: string): string =>
  createHash("sha256").update(input).digest("hex")

export const parseScope = (raw: string | undefined | null): string[] => {
  if (!raw) return []
  return raw.split(/\s+/).filter(s => s.length > 0)
}

export const formatScope = (scopes: readonly string[]): string => scopes.join(" ")

/**
 * Subset check — returns true if every scope in `requested` is present in `allowed`.
 * Used both for validating the OAuth grant scope vs. client's allowed_scopes
 * and for scope-checking individual API requests.
 */
export const includesScopes = (allowed: readonly string[], requested: readonly string[]): boolean =>
  requested.every(s => allowed.includes(s))

/**
 * Exact-string redirect_uri match per OAuth 2.0 Security BCP. We never accept
 * substring matching — that's the source of countless open-redirect CVEs.
 */
export const isAllowedRedirect = (requested: string, allowed: readonly string[]): boolean =>
  allowed.some(uri => uri === requested)

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60          // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30  // 30 days
export const AUTH_CODE_TTL_SECONDS = 60                  // 1 minute

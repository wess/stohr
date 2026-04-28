import { createHash, randomBytes } from "node:crypto"
import { deleteSecret, getSecret, setSecret } from "./keychain.ts"
import type { Config } from "./config.ts"

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

export const newPkcePair = (): { verifier: string; challenge: string } => {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export const buildAuthorizeUrl = (
  cfg: Config,
  pkceChallenge: string,
  state: string,
  scope = "read write share",
): string => {
  if (!cfg.clientId) throw new Error("Stohr client_id is not configured")
  const u = new URL(`${cfg.serverUrl.replace(/\/api$/, "")}/oauth/authorize`)
  u.searchParams.set("response_type", "code")
  u.searchParams.set("client_id", cfg.clientId)
  u.searchParams.set("redirect_uri", cfg.redirectUri)
  u.searchParams.set("scope", scope)
  u.searchParams.set("code_challenge", pkceChallenge)
  u.searchParams.set("code_challenge_method", "S256")
  u.searchParams.set("state", state)
  return u.toString()
}

export type Tokens = {
  access_token: string
  refresh_token: string
  expires_at: number  // ms since epoch
  scope: string
}

export const exchangeCode = async (
  cfg: Config,
  code: string,
  codeVerifier: string,
): Promise<Tokens> => {
  if (!cfg.clientId) throw new Error("client_id not configured")
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    code_verifier: codeVerifier,
    redirect_uri: cfg.redirectUri,
  })
  const res = await fetch(`${cfg.serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })
  const j = await res.json() as any
  if (!res.ok || j.error) {
    throw new Error(j.error_description ?? j.error ?? `HTTP ${res.status}`)
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in ?? 3600) - 30) * 1000,
    scope: j.scope ?? "",
  }
}

export const refreshTokens = async (cfg: Config, refreshToken: string): Promise<Tokens> => {
  if (!cfg.clientId) throw new Error("client_id not configured")
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  })
  const res = await fetch(`${cfg.serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })
  const j = await res.json() as any
  if (!res.ok || j.error) {
    throw new Error(j.error_description ?? j.error ?? `HTTP ${res.status}`)
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in ?? 3600) - 30) * 1000,
    scope: j.scope ?? "",
  }
}

export const persistTokens = async (t: Tokens): Promise<void> => {
  await setSecret("tokens", JSON.stringify(t))
}

export const loadTokens = async (): Promise<Tokens | null> => {
  const raw = await getSecret("tokens")
  if (!raw) return null
  try {
    return JSON.parse(raw) as Tokens
  } catch {
    return null
  }
}

export const clearTokens = async (): Promise<void> => {
  await deleteSecret("tokens")
}

/**
 * Simple in-memory pending-flow state. We don't store PKCE verifiers on
 * disk — the flow either completes during this app session or it doesn't.
 */
export type PendingFlow = {
  verifier: string
  state: string
  startedAt: number
}

let pending: PendingFlow | null = null

export const startFlow = (verifier: string, state: string): void => {
  pending = { verifier, state, startedAt: Date.now() }
}

export const consumeFlow = (state: string): PendingFlow | null => {
  if (!pending || pending.state !== state) return null
  // 10 minute window.
  if (Date.now() - pending.startedAt > 10 * 60 * 1000) {
    pending = null
    return null
  }
  const f = pending
  pending = null
  return f
}

export const clearFlow = (): void => { pending = null }

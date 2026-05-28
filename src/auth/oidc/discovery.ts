// Cache the issuer's discovery document and JWKS in memory for an hour.
// Most providers rotate signing keys infrequently; refetching every request
// would hammer the IdP unnecessarily.

type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri: string
  end_session_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
}

type Cached<T> = { value: T; expiresAt: number }

const TTL_MS = 60 * 60 * 1000

const discoveryCache = new Map<string, Cached<Discovery>>()

const trimRight = (s: string, ch: string) => s.endsWith(ch) ? s.slice(0, -1) : s

export const fetchDiscovery = async (issuerUrl: string): Promise<Discovery> => {
  const key = trimRight(issuerUrl, "/")
  const hit = discoveryCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const url = `${key}/.well-known/openid-configuration`
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`)
  }
  const value = await res.json() as Discovery
  if (!value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) {
    throw new Error("OIDC discovery document missing required endpoints")
  }
  discoveryCache.set(key, { value, expiresAt: Date.now() + TTL_MS })
  return value
}

export const clearDiscoveryCache = (): void => {
  discoveryCache.clear()
}

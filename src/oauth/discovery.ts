import { get, json } from "@atlas/server"
import { SUPPORTED_SCOPES } from "./helpers.ts"

const issuerFromRequest = (req: Request): string => {
  const url = new URL(req.url)
  return `${url.protocol}//${url.host}`
}

export const oauthDiscoveryRoutes = () => [
  // RFC 8414 — OAuth 2.0 Authorization Server Metadata.
  get("/.well-known/oauth-authorization-server", async (c) => {
    const issuer = issuerFromRequest(c.request)
    return json(c, 200, {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    })
  }),
]

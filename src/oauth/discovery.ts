import { get, json } from "@atlas/server"
import { requestBaseUrl } from "../teams/request.ts"
import { SUPPORTED_SCOPES } from "./helpers.ts"

// The issuer is the configured public URL of the team the request was
// resolved to, never the raw Host header — withTeams only lets a host
// through when it is ROOT_DOMAIN or a live team subdomain, and the base url
// is rebuilt from config, so a client that can set Host still cannot point
// the metadata at a server of its choosing.
export const oauthDiscoveryRoutes = (appUrl: string) => {
  const metadata = (issuer: string) => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    device_authorization_endpoint: `${issuer}/oauth/device/authorize`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  })

  return [
    // RFC 8414 — OAuth 2.0 Authorization Server Metadata.
    get("/.well-known/oauth-authorization-server", async c =>
      json(c, 200, metadata(requestBaseUrl(c.request, appUrl))),
    ),
  ]
}

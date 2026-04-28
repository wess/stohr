import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import {
  AUTH_CODE_TTL_SECONDS,
  formatScope,
  includesScopes,
  isAllowedRedirect,
  parseScope,
  randomId,
} from "./helpers.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type ClientRow = {
  id: number
  client_id: string
  name: string
  description: string | null
  icon_url: string | null
  redirect_uris: string
  allowed_scopes: string
  is_official: boolean
  revoked_at: string | null
}

type AuthorizeParams = {
  response_type?: string
  client_id?: string
  redirect_uri?: string
  scope?: string
  state?: string
  code_challenge?: string
  code_challenge_method?: string
}

type ValidationResult =
  | { ok: true; client: ClientRow; redirect_uri: string; scopes: string[]; state?: string; code_challenge: string }
  | { ok: false; status: number; error: string; description?: string }

const findClient = async (db: Connection, clientId: string): Promise<ClientRow | null> =>
  await db.one(
    from("oauth_clients").where(q => q("client_id").equals(clientId)),
  ) as ClientRow | null

const validateAuthorize = async (db: Connection, params: AuthorizeParams): Promise<ValidationResult> => {
  if (params.response_type !== "code") {
    return { ok: false, status: 400, error: "unsupported_response_type", description: "Only response_type=code is supported" }
  }
  if (!params.client_id) {
    return { ok: false, status: 400, error: "invalid_request", description: "client_id is required" }
  }
  const client = await findClient(db, params.client_id)
  if (!client || client.revoked_at) {
    return { ok: false, status: 400, error: "invalid_client", description: "Unknown or revoked client" }
  }
  if (!params.redirect_uri) {
    return { ok: false, status: 400, error: "invalid_request", description: "redirect_uri is required" }
  }
  const allowedRedirects = JSON.parse(client.redirect_uris) as string[]
  if (!isAllowedRedirect(params.redirect_uri, allowedRedirects)) {
    return { ok: false, status: 400, error: "invalid_request", description: "redirect_uri does not match a registered URI for this client" }
  }
  if (params.code_challenge_method && params.code_challenge_method !== "S256") {
    return { ok: false, status: 400, error: "invalid_request", description: "Only code_challenge_method=S256 is supported" }
  }
  if (!params.code_challenge) {
    return { ok: false, status: 400, error: "invalid_request", description: "code_challenge is required (PKCE is mandatory)" }
  }
  const allowedScopes = JSON.parse(client.allowed_scopes) as string[]
  const requestedScopes = parseScope(params.scope) // empty list = grant all allowed
  const finalScopes = requestedScopes.length === 0 ? allowedScopes : requestedScopes
  if (!includesScopes(allowedScopes, finalScopes)) {
    return { ok: false, status: 400, error: "invalid_scope", description: `Requested scopes must be a subset of: ${allowedScopes.join(" ")}` }
  }
  return {
    ok: true,
    client,
    redirect_uri: params.redirect_uri,
    scopes: finalScopes,
    state: params.state,
    code_challenge: params.code_challenge,
  }
}

const buildErrorRedirect = (redirectUri: string, error: string, description?: string, state?: string): string => {
  const url = new URL(redirectUri)
  url.searchParams.set("error", error)
  if (description) url.searchParams.set("error_description", description)
  if (state) url.searchParams.set("state", state)
  return url.toString()
}

const buildSuccessRedirect = (redirectUri: string, code: string, state?: string): string => {
  const url = new URL(redirectUri)
  url.searchParams.set("code", code)
  if (state) url.searchParams.set("state", state)
  return url.toString()
}

export const oauthAuthorizeRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    // The SPA hits this to render the consent screen. We validate every parameter
    // so the user never approves a misconfigured request.
    get("/oauth/authorize/info", guard(async (c) => {
      const url = new URL(c.request.url)
      const params: AuthorizeParams = {
        response_type: url.searchParams.get("response_type") ?? undefined,
        client_id: url.searchParams.get("client_id") ?? undefined,
        redirect_uri: url.searchParams.get("redirect_uri") ?? undefined,
        scope: url.searchParams.get("scope") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        code_challenge: url.searchParams.get("code_challenge") ?? undefined,
        code_challenge_method: url.searchParams.get("code_challenge_method") ?? "S256",
      }
      const v = await validateAuthorize(db, params)
      if (!v.ok) {
        return json(c, v.status, { error: v.error, error_description: v.description })
      }
      return json(c, 200, {
        client: {
          client_id: v.client.client_id,
          name: v.client.name,
          description: v.client.description,
          icon_url: v.client.icon_url,
          is_official: v.client.is_official,
        },
        scopes: v.scopes,
        redirect_uri: v.redirect_uri,
        state: v.state ?? null,
      })
    })),

    post("/oauth/authorize/approve", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as AuthorizeParams
      const v = await validateAuthorize(db, body)
      if (!v.ok) {
        return json(c, v.status, { error: v.error, error_description: v.description })
      }

      const code = randomId(32)
      const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString()

      await db.execute(
        from("oauth_authorization_codes").insert({
          code,
          client_id: v.client.client_id,
          user_id: userId,
          redirect_uri: v.redirect_uri,
          code_challenge: v.code_challenge,
          code_challenge_method: "S256",
          scope: formatScope(v.scopes),
          expires_at: expiresAt,
        }),
      )

      logEvent(db, {
        userId,
        event: "oauth.authorize",
        metadata: { client_id: v.client.client_id, scopes: v.scopes },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })

      return json(c, 200, {
        redirect_url: buildSuccessRedirect(v.redirect_uri, code, v.state),
      })
    })),

    post("/oauth/authorize/deny", authed(async (c) => {
      const body = c.body as AuthorizeParams
      const v = await validateAuthorize(db, body)
      if (!v.ok) {
        return json(c, v.status, { error: v.error, error_description: v.description })
      }
      logEvent(db, {
        userId: authId(c),
        event: "oauth.deny",
        metadata: { client_id: v.client.client_id },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, {
        redirect_url: buildErrorRedirect(v.redirect_uri, "access_denied", "User denied the authorization request", v.state),
      })
    })),
  ]
}

// Periodic cleanup of expired auth codes — they're 60-second TTL, so stale ones
// are useless to keep around.
export const sweepExpiredAuthCodes = async (db: Connection): Promise<void> => {
  try {
    await db.execute(
      from("oauth_authorization_codes").where(q => q("expires_at").lessThan(raw("NOW()"))).del(),
    )
  } catch (err) {
    console.error("[oauth] auth-code sweep failed:", err)
  }
}

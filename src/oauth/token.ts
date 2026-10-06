import { timingSafeEqual } from "node:crypto"
import { token as jwt } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { json, parseForm, pipeline, post } from "@atlas/server"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { teamFor } from "../teams/request.ts"
import { parseJson } from "../util/json/index.ts"
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  formatScope,
  parseScope,
  REFRESH_TOKEN_TTL_SECONDS,
  randomId,
  sha256,
  verifyPkceS256,
} from "./helpers.ts"

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

type ClientRow = {
  id: number
  client_id: string
  client_secret_hash: string | null
  redirect_uris: string
  allowed_scopes: string
  revoked_at: string | null
}

type AuthCodeRow = {
  code: string
  client_id: string
  user_id: number
  redirect_uri: string
  code_challenge: string
  scope: string
  expires_at: string
  used_at: string | null
}

type RefreshRow = {
  token_hash: string
  client_id: string
  user_id: number
  scope: string
  parent_token_hash: string | null
  expires_at: string
  revoked_at: string | null
}

type UserRow = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
  team_id: number
  oauth_epoch: number
  deleted_at: string | null
  suspended_at: string | null
}

const findClient = async (db: Connection, clientId: string): Promise<ClientRow | null> =>
  (await db.one(from("oauth_clients").where(q => q("client_id").equals(clientId)))) as ClientRow | null

const findUser = async (db: Connection, id: number): Promise<UserRow | null> =>
  (await db.one(
    from("users")
      .where(q => q("id").equals(id))
      .select("id", "email", "username", "name", "is_owner", "team_id", "deleted_at", "suspended_at", "oauth_epoch"),
  )) as UserRow | null

// A grant (code, refresh token, device code) belongs to its user's team and
// the tokens it yields only ever work on that team's host, so it is redeemed
// there and nowhere else. requireAuth would refuse the access token anyway;
// refusing here keeps the refresh token from being minted at all.
const onThisHost = (c: any, user: UserRow): boolean => Number(user.team_id) === teamFor(c.request as Request).team.id

const oauthError = (c: any, status: number, error: string, description?: string) =>
  json(c, status, description ? { error, error_description: description } : { error })

const issueTokens = async (
  db: Connection,
  secret: string,
  user: UserRow,
  clientId: string,
  scope: string,
  parentTokenHash?: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string }> => {
  const accessToken = await jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      is_owner: user.is_owner,
      client_id: clientId,
      scope,
      oauth_epoch: Number(user.oauth_epoch),
      jti: randomId(16),
    },
    secret,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  )
  const refreshToken = `oat_${randomId(32)}`
  const refreshHash = sha256(refreshToken)
  await db.execute(
    from("oauth_refresh_tokens").insert({
      token_hash: refreshHash,
      client_id: clientId,
      user_id: user.id,
      scope,
      parent_token_hash: parentTokenHash ?? null,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    }),
  )
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  }
}

const verifyClientCredentials = async (client: ClientRow, providedSecret: string | undefined): Promise<boolean> => {
  // Public clients (no stored secret) skip secret verification — PKCE is the
  // proof-of-possession instead.
  if (!client.client_secret_hash) return true
  if (!providedSecret) return false
  // Constant-time compare on the hex digests. Both buffers are SHA-256 hex
  // so they're always 64 bytes; the length-equality guard is defense in depth.
  const a = Buffer.from(sha256(providedSecret), "hex")
  const b = Buffer.from(client.client_secret_hash, "hex")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export const oauthTokenRoutes = (db: Connection, secret: string) => {
  // The token endpoint accepts both application/x-www-form-urlencoded (the
  // OAuth spec default) and JSON for convenience. Both parsers are no-ops if
  // the content-type doesn't match, so chaining them is safe.
  const parseBody = pipeline(parseJson, parseForm)

  const handle = async (c: any) => {
    const body = (c.body ?? {}) as Record<string, string | undefined>
    const grantType = body.grant_type
    const ip = clientIp(c.request)
    const ua = userAgent(c.request)

    if (grantType === "authorization_code") {
      const clientId = body.client_id
      const code = body.code
      const codeVerifier = body.code_verifier
      const redirectUri = body.redirect_uri
      const clientSecret = body.client_secret

      if (!clientId || !code || !codeVerifier || !redirectUri) {
        return oauthError(c, 400, "invalid_request", "client_id, code, code_verifier and redirect_uri are required")
      }
      const client = await findClient(db, clientId)
      if (!client || client.revoked_at) {
        return oauthError(c, 400, "invalid_client", "Unknown or revoked client")
      }
      if (!(await verifyClientCredentials(client, clientSecret))) {
        return oauthError(c, 401, "invalid_client", "Bad client credentials")
      }

      return db.transaction(async tx => {
        await tx.execute({
          text: `SELECT u.id FROM users u JOIN oauth_authorization_codes a ON a.user_id = u.id
                  WHERE a.code = $1 FOR UPDATE OF u`,
          values: [code],
        })
        // Atomic single-use: only succeed if used_at was still null.
        const claimed = (await tx.execute(
          from("oauth_authorization_codes")
            .where(q => q("code").equals(code))
            .where(q => q("used_at").isNull())
            .update({ used_at: raw("NOW()") })
            .returning("code", "client_id", "user_id", "redirect_uri", "code_challenge", "scope", "expires_at"),
        )) as Array<
          Pick<
            AuthCodeRow,
            "code" | "client_id" | "user_id" | "redirect_uri" | "code_challenge" | "scope" | "expires_at"
          >
        >

        const claimedCode = claimed[0]
        if (!claimedCode) {
          return oauthError(c, 400, "invalid_grant", "Code not found or already used")
        }
        if (new Date(claimedCode.expires_at).getTime() < Date.now()) {
          return oauthError(c, 400, "invalid_grant", "Code expired")
        }
        if (claimedCode.client_id !== clientId) {
          return oauthError(c, 400, "invalid_grant", "Code was issued for a different client")
        }
        if (claimedCode.redirect_uri !== redirectUri) {
          return oauthError(c, 400, "invalid_grant", "redirect_uri does not match the one used at /oauth/authorize")
        }
        if (!verifyPkceS256(codeVerifier, claimedCode.code_challenge)) {
          return oauthError(c, 400, "invalid_grant", "PKCE verifier did not match the challenge")
        }

        const user = await findUser(tx, claimedCode.user_id)
        if (!user || user.deleted_at || user.suspended_at) {
          return oauthError(c, 400, "invalid_grant", "User no longer exists")
        }
        if (!onThisHost(c, user)) {
          return oauthError(c, 400, "invalid_grant", "Code was issued on a different host")
        }

        const tokens = await issueTokens(tx, secret, user, clientId, claimedCode.scope)
        logEvent(db, {
          userId: user.id,
          event: "oauth.token_issued",
          metadata: { client_id: clientId, grant: "authorization_code", scope: claimedCode.scope },
          ip,
          userAgent: ua,
        })
        return json(c, 200, tokens)
      })
    }

    if (grantType === "refresh_token") {
      const clientId = body.client_id
      const refreshToken = body.refresh_token
      const requestedScope = body.scope
      const clientSecret = body.client_secret

      if (!clientId || !refreshToken) {
        return oauthError(c, 400, "invalid_request", "client_id and refresh_token are required")
      }
      const client = await findClient(db, clientId)
      if (!client || client.revoked_at) {
        return oauthError(c, 400, "invalid_client", "Unknown or revoked client")
      }
      if (!(await verifyClientCredentials(client, clientSecret))) {
        return oauthError(c, 401, "invalid_client", "Bad client credentials")
      }

      return db.transaction(async tx => {
        const tokenHash = sha256(refreshToken)
        await tx.execute({
          text: `SELECT u.id FROM users u JOIN oauth_refresh_tokens r ON r.user_id = u.id
                WHERE r.token_hash = $1 FOR UPDATE OF u`,
          values: [tokenHash],
        })
        const row = (await tx.one(
          from("oauth_refresh_tokens").where(q => q("token_hash").equals(tokenHash)),
        )) as RefreshRow | null

        if (!row) {
          return oauthError(c, 400, "invalid_grant", "Unknown refresh token")
        }
        if (row.client_id !== clientId) {
          return oauthError(c, 400, "invalid_grant", "Token was issued for a different client")
        }
        if (new Date(row.expires_at).getTime() < Date.now()) {
          return oauthError(c, 400, "invalid_grant", "Refresh token expired")
        }
        // Before rotation: a refresh presented on the wrong host is refused
        // without touching the chain, so the client at home keeps working.
        const user = await findUser(tx, row.user_id)
        if (!user || user.deleted_at || user.suspended_at) {
          return oauthError(c, 400, "invalid_grant", "User no longer exists")
        }
        if (!onThisHost(c, user)) {
          return oauthError(c, 400, "invalid_grant", "Refresh token was issued on a different host")
        }

        if (row.revoked_at) {
          // A revoked-but-presented token is a strong signal of leakage —
          // burn the entire chain that descended from this token's parent.
          await tx.execute(
            from("oauth_refresh_tokens")
              .where(q => q("user_id").equals(row.user_id))
              .where(q => q("client_id").equals(row.client_id))
              .where(q => q("revoked_at").isNull())
              .update({ revoked_at: raw("NOW()") }),
          )
          logEvent(db, {
            userId: row.user_id,
            event: "oauth.refresh_reuse_detected",
            metadata: { client_id: row.client_id },
            ip,
            userAgent: ua,
          })
          return oauthError(c, 400, "invalid_grant", "Refresh token has been revoked")
        }

        // Rotate: revoke this refresh, mint a new pair.
        await tx.execute(
          from("oauth_refresh_tokens")
            .where(q => q("token_hash").equals(tokenHash))
            .update({ revoked_at: raw("NOW()") }),
        )

        // Scope down-narrowing only — never widen.
        let scope = row.scope
        if (requestedScope) {
          const requested = parseScope(requestedScope)
          const original = parseScope(row.scope)
          const downscoped = requested.filter(s => original.includes(s))
          if (downscoped.length === 0) {
            return oauthError(c, 400, "invalid_scope", "Requested scope must be a subset of the original grant")
          }
          scope = formatScope(downscoped)
        }

        const tokens = await issueTokens(tx, secret, user, clientId, scope, tokenHash)
        logEvent(db, {
          userId: user.id,
          event: "oauth.token_refreshed",
          metadata: { client_id: clientId, scope },
          ip,
          userAgent: ua,
        })
        return json(c, 200, tokens)
      })
    }

    if (grantType === DEVICE_CODE_GRANT) {
      const clientId = body.client_id
      const deviceCode = body.device_code
      const clientSecret = body.client_secret
      if (!clientId || !deviceCode) {
        return oauthError(c, 400, "invalid_request", "client_id and device_code are required")
      }
      const client = await findClient(db, clientId)
      if (!client || client.revoked_at) {
        return oauthError(c, 400, "invalid_client", "Unknown or revoked client")
      }
      if (!(await verifyClientCredentials(client, clientSecret))) {
        return oauthError(c, 401, "invalid_client", "Bad client credentials")
      }

      return db.transaction(async tx => {
        await tx.execute({
          text: `SELECT u.id FROM users u JOIN oauth_device_codes d ON d.user_id = u.id
                  WHERE d.device_code = $1 FOR UPDATE OF u`,
          values: [deviceCode],
        })
        const row = (await tx.one(from("oauth_device_codes").where(q => q("device_code").equals(deviceCode)))) as {
          device_code: string
          user_code: string
          client_id: string
          scope: string
          user_id: number | null
          approved_at: string | null
          denied_at: string | null
          last_polled_at: string | null
          expires_at: string
        } | null

        if (!row) return oauthError(c, 400, "invalid_grant", "Unknown device_code")
        if (row.client_id !== clientId)
          return oauthError(c, 400, "invalid_grant", "Code was issued for a different client")

        const expiredAt = new Date(row.expires_at).getTime()
        if (expiredAt < Date.now()) return oauthError(c, 400, "expired_token", "Device code expired")

        // Per RFC 8628: enforce slow_down if the client polls faster than the
        // advertised interval.
        const now = Date.now()
        const last = row.last_polled_at ? new Date(row.last_polled_at).getTime() : 0
        if (last && now - last < (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000) {
          await tx.execute(
            from("oauth_device_codes")
              .where(q => q("device_code").equals(deviceCode))
              .update({ last_polled_at: raw("NOW()") }),
          )
          return oauthError(c, 400, "slow_down", "Polling too fast — wait at least the advertised interval")
        }
        await tx.execute(
          from("oauth_device_codes")
            .where(q => q("device_code").equals(deviceCode))
            .update({ last_polled_at: raw("NOW()") }),
        )

        if (row.denied_at) {
          return oauthError(c, 400, "access_denied", "User denied the authorization request")
        }
        if (!row.approved_at || !row.user_id) {
          return oauthError(c, 400, "authorization_pending", "Waiting for user approval")
        }

        const user = await findUser(tx, row.user_id)
        if (!user || user.deleted_at || user.suspended_at)
          return oauthError(c, 400, "invalid_grant", "User no longer exists")
        if (!onThisHost(c, user)) {
          return oauthError(c, 400, "invalid_grant", "Device code was approved on a different host")
        }

        const claimed = (await tx.execute({
          text: `DELETE FROM oauth_device_codes
                WHERE device_code = $1 AND approved_at IS NOT NULL
                  AND denied_at IS NULL AND expires_at >= NOW()
                RETURNING device_code`,
          values: [deviceCode],
        })) as Array<{ device_code: string }>
        if (claimed.length === 0) return oauthError(c, 400, "invalid_grant", "Device code already used")

        const tokens = await issueTokens(tx, secret, user, clientId, row.scope)
        logEvent(db, {
          userId: user.id,
          event: "oauth.token_issued",
          metadata: { client_id: clientId, grant: "device_code", scope: row.scope },
          ip,
          userAgent: ua,
        })
        return json(c, 200, tokens)
      })
    }

    return oauthError(c, 400, "unsupported_grant_type", `Unknown grant_type: ${grantType ?? "(missing)"}`)
  }

  return [post("/oauth/token", parseBody(handle))]
}

export const oauthRevokeRoutes = (db: Connection) => {
  const parseBody = pipeline(parseJson, parseForm)

  const handle = async (c: any) => {
    const body = (c.body ?? {}) as Record<string, string | undefined>
    const tokenStr = body.token
    if (!tokenStr) return json(c, 400, { error: "invalid_request", error_description: "token is required" })

    // Per RFC 7009 we silently succeed even if the token doesn't exist, to
    // avoid leaking validity info. We only revoke our refresh tokens; access
    // tokens are short-lived JWTs that expire on their own.
    if (tokenStr.startsWith("oat_")) {
      const tokenHash = sha256(tokenStr)
      await db.execute(
        from("oauth_refresh_tokens")
          .where(q => q("token_hash").equals(tokenHash))
          .update({ revoked_at: raw("NOW()") }),
      )
    }
    return json(c, 200, {})
  }

  return [post("/oauth/revoke", parseBody(handle))]
}

export const sweepExpiredRefreshTokens = async (db: Connection): Promise<void> => {
  try {
    await db.execute(
      from("oauth_refresh_tokens")
        .where(q => q("expires_at").lessThan(raw("NOW()")))
        .del(),
    )
  } catch (err) {
    console.error("[oauth] refresh-token sweep failed:", err)
  }
}

import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseForm, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  formatScope,
  includesScopes,
  newUserCode,
  normalizeUserCode,
  parseScope,
  randomId,
} from "./helpers.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type ClientRow = {
  client_id: string
  name: string
  description: string | null
  icon_url: string | null
  allowed_scopes: string
  is_official: boolean
  revoked_at: string | null
}

type DeviceCodeRow = {
  device_code: string
  user_code: string
  client_id: string
  scope: string
  user_id: number | null
  approved_at: string | null
  denied_at: string | null
  last_polled_at: string | null
  expires_at: string
}

const findClient = async (db: Connection, clientId: string) =>
  await db.one(from("oauth_clients").where(q => q("client_id").equals(clientId))) as ClientRow | null

const buildVerificationUri = (req: Request): string => {
  const u = new URL(req.url)
  return `${u.protocol}//${u.host}/pair`
}

export const deviceAuthorizeRoutes = (db: Connection, secret: string) => {
  const parseBody = pipeline(parseJson, parseForm)
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    // Step 1 — desktop client calls this to start the flow.
    post("/oauth/device/authorize", parseBody(async (c) => {
      const body = (c.body ?? {}) as { client_id?: string; scope?: string }
      const clientId = body.client_id
      if (!clientId) {
        return json(c, 400, { error: "invalid_request", error_description: "client_id is required" })
      }
      const client = await findClient(db, clientId)
      if (!client || client.revoked_at) {
        return json(c, 400, { error: "invalid_client", error_description: "Unknown or revoked client" })
      }
      const allowed = JSON.parse(client.allowed_scopes) as string[]
      const requested = parseScope(body.scope)
      const scopes = requested.length === 0 ? allowed : requested
      if (!includesScopes(allowed, scopes)) {
        return json(c, 400, {
          error: "invalid_scope",
          error_description: `Requested scopes must be a subset of: ${allowed.join(" ")}`,
        })
      }

      const deviceCode = randomId(32)
      const userCode = newUserCode()
      const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000)

      await db.execute(
        from("oauth_device_codes").insert({
          device_code: deviceCode,
          user_code: userCode,
          client_id: clientId,
          scope: formatScope(scopes),
          expires_at: expiresAt.toISOString(),
        }),
      )

      const verificationUri = buildVerificationUri(c.request)
      return json(c, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      })
    })),

    // Step 2 (server side of /pair) — the SPA fetches this to render consent.
    get("/oauth/device/info", guard(async (c) => {
      const url = new URL(c.request.url)
      const raw = url.searchParams.get("user_code") ?? ""
      const userCode = normalizeUserCode(raw)
      if (userCode.length === 0) {
        return json(c, 400, { error: "invalid_request", error_description: "user_code is required" })
      }
      const row = await db.one(
        from("oauth_device_codes").where(q => q("user_code").equals(userCode)),
      ) as DeviceCodeRow | null
      if (!row) {
        return json(c, 404, { error: "not_found", error_description: "No matching code — check the characters and try again." })
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json(c, 410, { error: "expired_token", error_description: "This code has expired — go back to your app and start over." })
      }
      if (row.approved_at || row.denied_at) {
        return json(c, 409, { error: "already_decided", error_description: "This code has already been used." })
      }
      const client = await findClient(db, row.client_id)
      if (!client || client.revoked_at) {
        return json(c, 400, { error: "invalid_client", error_description: "Client no longer exists." })
      }
      return json(c, 200, {
        client: {
          client_id: client.client_id,
          name: client.name,
          description: client.description,
          icon_url: client.icon_url,
          is_official: client.is_official,
        },
        scopes: parseScope(row.scope),
        user_code: row.user_code,
      })
    })),

    post("/oauth/device/approve", authed(async (c) => {
      const body = c.body as { user_code?: string }
      const userCode = normalizeUserCode(body.user_code ?? "")
      if (!userCode) return json(c, 400, { error: "invalid_request", error_description: "user_code is required" })

      const claimed = await db.execute(
        from("oauth_device_codes")
          .where(q => q("user_code").equals(userCode))
          .where(q => q("approved_at").isNull())
          .where(q => q("denied_at").isNull())
          .update({ approved_at: raw("NOW()"), user_id: authId(c) })
          .returning("device_code", "client_id", "expires_at"),
      ) as Array<{ device_code: string; client_id: string; expires_at: string }>

      const row = claimed[0]
      if (!row) return json(c, 404, { error: "not_found", error_description: "No active code — it may have expired or already been used." })
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await db.execute(
          from("oauth_device_codes").where(q => q("device_code").equals(row.device_code)).update({ approved_at: null }),
        )
        return json(c, 410, { error: "expired_token", error_description: "This code expired before you could approve it." })
      }

      logEvent(db, {
        userId: authId(c),
        event: "oauth.device_approved",
        metadata: { client_id: row.client_id },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { ok: true })
    })),

    post("/oauth/device/deny", authed(async (c) => {
      const body = c.body as { user_code?: string }
      const userCode = normalizeUserCode(body.user_code ?? "")
      if (!userCode) return json(c, 400, { error: "invalid_request", error_description: "user_code is required" })

      const claimed = await db.execute(
        from("oauth_device_codes")
          .where(q => q("user_code").equals(userCode))
          .where(q => q("approved_at").isNull())
          .where(q => q("denied_at").isNull())
          .update({ denied_at: raw("NOW()"), user_id: authId(c) })
          .returning("device_code", "client_id"),
      ) as Array<{ device_code: string; client_id: string }>
      const row = claimed[0]
      if (!row) return json(c, 404, { error: "not_found" })

      logEvent(db, {
        userId: authId(c),
        event: "oauth.device_denied",
        metadata: { client_id: row.client_id },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { ok: true })
    })),
  ]
}

export const sweepExpiredDeviceCodes = async (db: Connection): Promise<void> => {
  try {
    await db.execute(
      from("oauth_device_codes").where(q => q("expires_at").lessThan(raw("NOW()"))).del(),
    )
  } catch (err) {
    console.error("[oauth] device-code sweep failed:", err)
  }
}

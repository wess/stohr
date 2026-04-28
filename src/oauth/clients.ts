import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, halt, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { isScope, randomId, sha256, shortId, SUPPORTED_SCOPES } from "./helpers.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const ownerOnly = async (c: any) => {
  if (!c.assigns?.auth?.is_owner) return halt(c, 403, { error: "Owner access required" })
  return c
}

type ClientRow = {
  id: number
  client_id: string
  client_secret_hash: string | null
  name: string
  description: string | null
  icon_url: string | null
  redirect_uris: string | string[]
  allowed_scopes: string | string[]
  is_official: boolean
  created_at: string
  revoked_at: string | null
}

const parseJsonArray = (v: string | string[] | null | undefined): string[] => {
  if (!v) return []
  if (Array.isArray(v)) return v
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const validateRedirectUris = (uris: unknown): { ok: true; uris: string[] } | { ok: false; error: string } => {
  if (!Array.isArray(uris) || uris.length === 0) {
    return { ok: false, error: "redirect_uris must be a non-empty array" }
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || uri.length === 0) {
      return { ok: false, error: "Every redirect_uri must be a non-empty string" }
    }
    // Allow http(s) and custom schemes (e.g. butter://callback). Reject obvious garbage.
    if (!/^[a-z][a-z0-9+.\-]*:/i.test(uri)) {
      return { ok: false, error: `Invalid redirect_uri: ${uri}` }
    }
  }
  return { ok: true, uris: uris as string[] }
}

const validateScopes = (scopes: unknown): { ok: true; scopes: string[] } | { ok: false; error: string } => {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { ok: false, error: `allowed_scopes must be a non-empty array. Supported: ${SUPPORTED_SCOPES.join(", ")}` }
  }
  for (const s of scopes) {
    if (typeof s !== "string" || !isScope(s)) {
      return { ok: false, error: `Unknown scope: ${s}. Supported: ${SUPPORTED_SCOPES.join(", ")}` }
    }
  }
  return { ok: true, scopes: scopes as string[] }
}

const toPublicClient = (row: ClientRow) => ({
  id: row.id,
  client_id: row.client_id,
  name: row.name,
  description: row.description,
  icon_url: row.icon_url,
  redirect_uris: parseJsonArray(row.redirect_uris),
  allowed_scopes: parseJsonArray(row.allowed_scopes),
  is_official: row.is_official,
  is_public_client: row.client_secret_hash === null,
  created_at: row.created_at,
  revoked_at: row.revoked_at,
})

export const oauthClientRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerOnly)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerOnly, parseJson)

  return [
    get("/admin/oauth/clients", guard(async (c) => {
      const rows = await db.all(
        from("oauth_clients").orderBy("created_at", "DESC"),
      ) as ClientRow[]
      return json(c, 200, rows.map(toPublicClient))
    })),

    post("/admin/oauth/clients", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as {
        name?: string
        description?: string
        icon_url?: string
        redirect_uris?: unknown
        allowed_scopes?: unknown
        is_official?: boolean
        is_public_client?: boolean
      }
      const name = body.name?.trim()
      if (!name) return json(c, 422, { error: "name is required" })

      const uris = validateRedirectUris(body.redirect_uris)
      if (!uris.ok) return json(c, 422, { error: uris.error })
      const scopes = validateScopes(body.allowed_scopes)
      if (!scopes.ok) return json(c, 422, { error: scopes.error })

      const clientId = shortId()
      const isPublic = body.is_public_client !== false  // default to public (PKCE)
      const secretRaw = isPublic ? null : `cs_${randomId(32)}`
      const secretHash = secretRaw ? sha256(secretRaw) : null

      const inserted = await db.execute(
        from("oauth_clients").insert({
          client_id: clientId,
          client_secret_hash: secretHash,
          name,
          description: body.description?.trim() || null,
          icon_url: body.icon_url?.trim() || null,
          redirect_uris: JSON.stringify(uris.uris),
          allowed_scopes: JSON.stringify(scopes.scopes),
          is_official: !!body.is_official,
          created_by: userId,
        }).returning(
          "id", "client_id", "client_secret_hash", "name", "description", "icon_url",
          "redirect_uris", "allowed_scopes", "is_official", "created_at", "revoked_at",
        ),
      ) as ClientRow[]

      logEvent(db, {
        userId,
        event: "oauth.client_created",
        metadata: { client_id: clientId, name, scopes: scopes.scopes, is_official: !!body.is_official },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })

      return json(c, 201, {
        ...toPublicClient(inserted[0]!),
        // Secret is returned exactly once at creation, only for confidential clients.
        ...(secretRaw ? { client_secret: secretRaw } : {}),
      })
    })),

    patch("/admin/oauth/clients/:id", authed(async (c) => {
      const id = Number(c.params.id)
      const body = c.body as {
        name?: string
        description?: string
        icon_url?: string
        redirect_uris?: unknown
        allowed_scopes?: unknown
        is_official?: boolean
      }
      const update: Record<string, unknown> = {}
      if (typeof body.name === "string") update.name = body.name.trim()
      if (typeof body.description === "string") update.description = body.description.trim() || null
      if (typeof body.icon_url === "string") update.icon_url = body.icon_url.trim() || null
      if (body.redirect_uris !== undefined) {
        const r = validateRedirectUris(body.redirect_uris)
        if (!r.ok) return json(c, 422, { error: r.error })
        update.redirect_uris = JSON.stringify(r.uris)
      }
      if (body.allowed_scopes !== undefined) {
        const s = validateScopes(body.allowed_scopes)
        if (!s.ok) return json(c, 422, { error: s.error })
        update.allowed_scopes = JSON.stringify(s.scopes)
      }
      if (typeof body.is_official === "boolean") update.is_official = body.is_official

      if (Object.keys(update).length === 0) return json(c, 422, { error: "Nothing to update" })

      await db.execute(
        from("oauth_clients").where(q => q("id").equals(id)).update(update),
      )

      const fresh = await db.one(
        from("oauth_clients").where(q => q("id").equals(id)),
      ) as ClientRow | null
      if (!fresh) return json(c, 404, { error: "Client not found" })

      logEvent(db, {
        userId: authId(c),
        event: "oauth.client_updated",
        metadata: { client_id: fresh.client_id, fields: Object.keys(update) },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })

      return json(c, 200, toPublicClient(fresh))
    })),

    del("/admin/oauth/clients/:id", guard(async (c) => {
      const id = Number(c.params.id)
      const row = await db.one(
        from("oauth_clients").where(q => q("id").equals(id)).select("client_id"),
      ) as { client_id: string } | null
      if (!row) return json(c, 404, { error: "Client not found" })

      // Mark revoked + cascade-invalidate every refresh token for this client.
      await db.execute(
        from("oauth_clients").where(q => q("id").equals(id)).update({ revoked_at: raw("NOW()") }),
      )
      await db.execute(
        from("oauth_refresh_tokens")
          .where(q => q("client_id").equals(row.client_id))
          .where(q => q("revoked_at").isNull())
          .update({ revoked_at: raw("NOW()") }),
      )

      logEvent(db, {
        userId: authId(c),
        event: "oauth.client_revoked",
        metadata: { client_id: row.client_id },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })

      return json(c, 200, { revoked: id })
    })),
  ]
}

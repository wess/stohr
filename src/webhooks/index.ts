import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { WEBHOOK_EVENTS } from "./dispatch.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const VALID_CONTENT_TYPES = ["application/json", "application/x-www-form-urlencoded"]

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

// Normalize a caller-supplied events list down to the known set. Unknown
// strings are dropped rather than rejected so a newer client subscribing to
// a future event doesn't hard-fail against an older server.
const normalizeEvents = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const set = new Set<string>()
  for (const e of raw) {
    if (typeof e === "string" && (WEBHOOK_EVENTS as string[]).includes(e)) set.add(e)
  }
  return Array.from(set)
}

const normalizeContentType = (raw: unknown): string => {
  const v = typeof raw === "string" ? raw.trim() : ""
  return VALID_CONTENT_TYPES.includes(v) ? v : "application/json"
}

// The secret never leaves the server once set. We surface a `has_secret`
// boolean instead so the SPA can show whether signing is configured.
const present = (r: any) => ({
  id: r.id,
  url: r.url,
  content_type: r.content_type,
  events: (() => {
    try {
      return JSON.parse(r.events) as string[]
    } catch {
      return []
    }
  })(),
  active: r.active,
  has_secret: !!r.secret,
  created_at: r.created_at,
})

export const webhookRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get(
      "/webhooks",
      guard(async c => {
        const userId = authId(c)
        const rows = await db.all(
          from("webhooks")
            .where(q => q("user_id").equals(userId))
            .select("id", "url", "secret", "content_type", "events", "active", "created_at")
            .orderBy("created_at", "DESC"),
        )
        return json(c, 200, rows.map(present))
      }),
    ),

    post(
      "/webhooks",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as {
          url?: string
          secret?: string
          content_type?: string
          contentType?: string
          events?: unknown
          active?: boolean
        }

        const url = body.url?.trim() ?? ""
        if (!url || !isHttpUrl(url)) return json(c, 422, { error: "A valid http(s) url is required" })

        const events = normalizeEvents(body.events)
        if (events.length === 0) return json(c, 422, { error: "At least one valid event is required" })

        const contentType = normalizeContentType(body.content_type ?? body.contentType)
        const hookSecret = body.secret?.trim() || null
        const active = body.active === undefined ? true : !!body.active

        const rows = (await db.execute(
          from("webhooks")
            .insert({
              user_id: userId,
              url,
              secret: hookSecret,
              content_type: contentType,
              events: JSON.stringify(events),
              active,
            })
            .returning("id", "url", "secret", "content_type", "events", "active", "created_at"),
        )) as Array<any>

        return json(c, 201, present(rows[0]))
      }),
    ),

    patch(
      "/webhooks/:id",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = c.body as {
          url?: string
          secret?: string | null
          content_type?: string
          contentType?: string
          events?: unknown
          active?: boolean
        }

        const existing = (await db.one(
          from("webhooks")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(userId)),
        )) as { id: number } | null
        if (!existing) return json(c, 404, { error: "Webhook not found" })

        const patchData: Record<string, unknown> = {}

        if (body.url !== undefined) {
          const url = body.url?.trim() ?? ""
          if (!url || !isHttpUrl(url)) return json(c, 422, { error: "A valid http(s) url is required" })
          patchData.url = url
        }
        if (body.events !== undefined) {
          const events = normalizeEvents(body.events)
          if (events.length === 0) return json(c, 422, { error: "At least one valid event is required" })
          patchData.events = JSON.stringify(events)
        }
        if (body.content_type !== undefined || body.contentType !== undefined) {
          patchData.content_type = normalizeContentType(body.content_type ?? body.contentType)
        }
        if (body.active !== undefined) patchData.active = !!body.active
        // Allow rotating the secret (string) or clearing it (explicit null).
        if (body.secret !== undefined) patchData.secret = body.secret ? String(body.secret).trim() : null

        if (Object.keys(patchData).length === 0) return json(c, 422, { error: "Nothing to update" })

        await db.execute(
          from("webhooks")
            .where(q => q("id").equals(id))
            .update(patchData),
        )

        const fresh = await db.one(
          from("webhooks")
            .where(q => q("id").equals(id))
            .select("id", "url", "secret", "content_type", "events", "active", "created_at"),
        )
        return json(c, 200, present(fresh))
      }),
    ),

    del(
      "/webhooks/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const row = (await db.one(
          from("webhooks")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(userId))
            .select("id"),
        )) as { id: number } | null
        if (!row) return json(c, 404, { error: "Webhook not found" })

        // Drop delivery history first to avoid an FK violation.
        await db.execute(
          from("webhook_deliveries")
            .where(q => q("webhook_id").equals(id))
            .del(),
        )
        await db.execute(
          from("webhooks")
            .where(q => q("id").equals(id))
            .del(),
        )
        return json(c, 200, { deleted: id })
      }),
    ),

    get(
      "/webhooks/:id/deliveries",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const hook = (await db.one(
          from("webhooks")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(userId))
            .select("id"),
        )) as { id: number } | null
        if (!hook) return json(c, 404, { error: "Webhook not found" })

        const url = new URL(c.request.url)
        const rawLimit = Number(url.searchParams.get("limit") ?? 50)
        const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 200))

        const rows = await db.all(
          from("webhook_deliveries")
            .where(q => q("webhook_id").equals(id))
            .select("id", "event", "status_code", "response_body", "duration_ms", "created_at")
            .orderBy("created_at", "DESC")
            .limit(limit),
        )
        return json(c, 200, rows)
      }),
    ),
  ]
}

import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { randomBytes } from "node:crypto"
import { requireAuth } from "../auth/guard.ts"
import { enqueue } from "../jobs/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const generateSecret = (): string =>
  `whsec_${randomBytes(32).toString("base64url")}`

const isValidUrl = (s: string): boolean => {
  try {
    const u = new URL(s)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch { return false }
}

const normalizeEvents = (input: unknown): string[] => {
  if (!Array.isArray(input)) return []
  return input
    .filter((e): e is string => typeof e === "string")
    .map(e => e.trim())
    .filter(Boolean)
    .slice(0, 32)
}

export const webhookRoutes = (db: Connection, secret: string) => {
  // Webhooks manage outbound delivery — first-party only, no OAuth tokens.
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }))
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), parseJson)

  return [
    get("/me/webhooks", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.all(
        from("webhooks")
          .where(q => q("user_id").equals(userId))
          .select("id", "url", "events", "enabled", "description",
                  "last_delivery_at", "last_status", "created_at")
          .orderBy("created_at", "DESC"),
      )
      return json(c, 200, rows)
    })),

    post("/me/webhooks", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { url?: string; events?: unknown; description?: string }
      const url = body.url?.trim()
      if (!url || !isValidUrl(url)) return json(c, 422, { error: "Valid http(s) url required" })

      const events = normalizeEvents(body.events)
      const description = body.description?.trim() || null
      const sec = generateSecret()

      const rows = await db.execute(
        from("webhooks").insert({
          user_id: userId,
          url,
          secret: sec,
          events: JSON.stringify(events),
          description,
        }).returning("id", "url", "events", "enabled", "description", "created_at"),
      ) as Array<{ id: number; url: string; events: unknown; enabled: boolean; description: string | null; created_at: string }>

      // Secret is shown once at creation, never on read paths.
      return json(c, 201, { ...rows[0], secret: sec })
    })),

    patch("/me/webhooks/:id", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const body = c.body as {
        url?: string
        events?: unknown
        enabled?: boolean
        description?: string
      }

      const owned = await db.one(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)).select("id"),
      ) as { id: number } | null
      if (!owned) return json(c, 404, { error: "Webhook not found" })

      const updates: Record<string, unknown> = { updated_at: raw("NOW()") }
      if (typeof body.url === "string") {
        if (!isValidUrl(body.url)) return json(c, 422, { error: "Invalid url" })
        updates.url = body.url
      }
      if (body.events !== undefined) updates.events = JSON.stringify(normalizeEvents(body.events))
      if (typeof body.enabled === "boolean") updates.enabled = body.enabled
      if (typeof body.description === "string") updates.description = body.description.trim() || null

      await db.execute(from("webhooks").where(q => q("id").equals(id)).update(updates))
      return json(c, 200, { id })
    })),

    post("/me/webhooks/:id/rotate-secret", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const owned = await db.one(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)).select("id"),
      ) as { id: number } | null
      if (!owned) return json(c, 404, { error: "Webhook not found" })

      const sec = generateSecret()
      await db.execute(
        from("webhooks").where(q => q("id").equals(id)).update({ secret: sec, updated_at: raw("NOW()") }),
      )
      return json(c, 200, { id, secret: sec })
    })),

    post("/me/webhooks/:id/test", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const hook = await db.one(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)).select("id"),
      ) as { id: number } | null
      if (!hook) return json(c, 404, { error: "Webhook not found" })

      const rows = await db.execute(
        from("webhook_deliveries").insert({
          webhook_id: id,
          event: "ping",
          payload: JSON.stringify({ event: "ping", message: "test delivery from Stohr" }),
        }).returning("id"),
      ) as Array<{ id: number | string }>
      const deliveryId = Number(rows[0]!.id)
      await enqueue(db, "webhook.deliver", { delivery_id: deliveryId }, { maxAttempts: 1 })
      return json(c, 202, { queued: deliveryId })
    })),

    get("/me/webhooks/:id/deliveries", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const owned = await db.one(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)).select("id"),
      ) as { id: number } | null
      if (!owned) return json(c, 404, { error: "Webhook not found" })

      const rows = await db.all(
        from("webhook_deliveries")
          .where(q => q("webhook_id").equals(id))
          .select("id", "event", "status", "response_status", "attempts",
                  "last_error", "created_at", "delivered_at")
          .orderBy("created_at", "DESC")
          .limit(100),
      )
      return json(c, 200, rows)
    })),

    del("/me/webhooks/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const owned = await db.one(
        from("webhooks").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)).select("id"),
      ) as { id: number } | null
      if (!owned) return json(c, 404, { error: "Webhook not found" })
      await db.execute(from("webhooks").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),
  ]
}

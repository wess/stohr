import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type NotificationRow = {
  id: number
  user_id: number
  kind: string
  resource_type: string | null
  resource_id: number | null
  actor_id: number | null
  payload: string | null
  read_at: string | null
  created_at: string
}

const hydrate = (row: NotificationRow) => ({
  id: row.id,
  kind: row.kind,
  resource_type: row.resource_type,
  resource_id: row.resource_id,
  actor_id: row.actor_id,
  payload: row.payload ? safeJson(row.payload) : null,
  read_at: row.read_at,
  created_at: row.created_at,
})

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export const notificationRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get(
      "/me/notifications",
      guard(async c => {
        const userId = authId(c)
        const url = new URL(c.request.url)
        const onlyUnread = url.searchParams.get("unread") === "1"
        const limitRaw = Number(url.searchParams.get("limit") ?? "50")
        const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50, 200))

        let q = from("notifications").where(p => p("user_id").equals(userId))
        if (onlyUnread) q = q.where(p => p("read_at").isNull())

        const rows = (await db.all(q.orderBy("created_at", "DESC").limit(limit))) as NotificationRow[]
        const unreadCount = (await db.one({
          text: `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
          values: [userId],
        })) as { n: number }
        return json(c, 200, {
          notifications: rows.map(hydrate),
          unread: unreadCount.n,
        })
      }),
    ),

    get(
      "/me/notifications/unread-count",
      guard(async c => {
        const userId = authId(c)
        const row = (await db.one({
          text: `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
          values: [userId],
        })) as { n: number }
        return json(c, 200, { unread: row.n })
      }),
    ),

    post(
      "/me/notifications/:id/read",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        await db.execute(
          from("notifications")
            .where(p => p("id").equals(id))
            .where(p => p("user_id").equals(userId))
            .where(p => p("read_at").isNull())
            .update({ read_at: raw("NOW()") }),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    post(
      "/me/notifications/read-all",
      authed(async c => {
        const userId = authId(c)
        await db.execute(
          from("notifications")
            .where(p => p("user_id").equals(userId))
            .where(p => p("read_at").isNull())
            .update({ read_at: raw("NOW()") }),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    del(
      "/me/notifications/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        await db.execute(
          from("notifications")
            .where(p => p("id").equals(id))
            .where(p => p("user_id").equals(userId))
            .del(),
        )
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}

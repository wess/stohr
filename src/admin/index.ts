import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const adminRoutes = (db: Connection, secret: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get("/admin/users", guard(async (c) => {
      const users = await db.all(
        from("users")
          .select("id", "username", "email", "name", "is_owner", "storage_quota_bytes", "created_at")
          .orderBy("created_at", "DESC"),
      ) as Array<{ id: number; username: string; email: string; name: string; is_owner: boolean; storage_quota_bytes: number | string; created_at: string }>

      const files = await db.all(
        from("files")
          .where(q => q("deleted_at").isNull())
          .select("user_id", "size"),
      ) as Array<{ user_id: number; size: number | string }>

      const usage = new Map<number, { bytes: number; files: number }>()
      for (const f of files) {
        const cur = usage.get(f.user_id) ?? { bytes: 0, files: 0 }
        usage.set(f.user_id, { bytes: cur.bytes + Number(f.size), files: cur.files + 1 })
      }

      return json(c, 200, users.map(u => ({
        ...u,
        storage_quota_bytes: Number(u.storage_quota_bytes),
        storage_bytes: usage.get(u.id)?.bytes ?? 0,
        file_count: usage.get(u.id)?.files ?? 0,
      })))
    })),

    post("/admin/users/:id/owner", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const body = c.body as { is_owner?: boolean }
      if (typeof body.is_owner !== "boolean") return json(c, 422, { error: "is_owner boolean required" })
      if (id === userId && body.is_owner === false) return json(c, 422, { error: "Cannot remove owner from yourself" })

      await db.execute(
        from("users").where(q => q("id").equals(id)).update({ is_owner: body.is_owner }),
      )
      return json(c, 200, { id, is_owner: body.is_owner })
    })),

    // Set a per-user storage cap in bytes. 0 means unlimited. This is the
    // only knob — there are no tiers; the owner caps individual accounts.
    post("/admin/users/:id/quota", authed(async (c) => {
      const id = Number(c.params.id)
      const body = c.body as { quota_bytes?: number; quotaBytes?: number }
      const requested = body.quota_bytes ?? body.quotaBytes
      if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) {
        return json(c, 422, { error: "quota_bytes must be a non-negative number (0 = unlimited)" })
      }
      const quota = Math.floor(requested)
      const exists = await db.one(
        from("users").where(q => q("id").equals(id)).select("id"),
      ) as { id: number } | null
      if (!exists) return json(c, 404, { error: "User not found" })
      await db.execute(
        from("users").where(q => q("id").equals(id)).update({ storage_quota_bytes: quota }),
      )
      return json(c, 200, { id, quota_bytes: quota })
    })),

    del("/admin/users/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      if (id === userId) return json(c, 422, { error: "Cannot delete yourself from admin — use Settings" })
      await db.execute(from("users").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),

    get("/admin/invites", guard(async (c) => {
      const url = new URL(c.request.url)
      const filter = url.searchParams.get("filter") ?? "all"
      // Plaintext token is never returned on read paths — only at create time.
      let q = from("invites").select("id", "email", "invited_by", "used_at", "used_by", "created_at")
      if (filter === "unused") q = q.where(p => p("used_at").isNull())
      if (filter === "used") q = q.where(p => p("used_at").isNotNull())

      const rows = await db.all(q.orderBy("created_at", "DESC").limit(500)) as Array<{
        id: number
        email: string | null
        invited_by: number | null
        used_at: string | null
        used_by: number | null
        created_at: string
      }>

      const userIds = Array.from(new Set([
        ...rows.map(r => r.invited_by).filter((x): x is number => x != null),
        ...rows.map(r => r.used_by).filter((x): x is number => x != null),
      ]))
      const users = userIds.length === 0 ? [] : await db.all(
        from("users").where(p => p("id").inList(userIds)).select("id", "username"),
      ) as Array<{ id: number; username: string }>
      const byId = new Map(users.map(u => [u.id, u.username]))

      return json(c, 200, rows.map(r => ({
        ...r,
        invited_by_username: r.invited_by ? byId.get(r.invited_by) ?? null : null,
        used_by_username: r.used_by ? byId.get(r.used_by) ?? null : null,
      })))
    })),

    del("/admin/invites/:id", guard(async (c) => {
      const id = Number(c.params.id)
      const row = await db.one(
        from("invites").where(q => q("id").equals(id)).select("id", "used_at"),
      ) as { id: number; used_at: string | null } | null
      if (!row) return json(c, 404, { error: "Invite not found" })
      if (row.used_at) return json(c, 409, { error: "Cannot delete a used invite" })
      await db.execute(from("invites").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),

    get("/admin/stats", guard(async (c) => {
      const users = await db.all(from("users").select("id")) as Array<{ id: number }>
      const folders = await db.all(from("folders").where(q => q("deleted_at").isNull()).select("id")) as Array<{ id: number }>
      const files = await db.all(from("files").where(q => q("deleted_at").isNull()).select("size")) as Array<{ size: number | string }>
      const invitesAll = await db.all(from("invites").select("id", "used_at")) as Array<{ id: number; used_at: string | null }>

      const totalBytes = files.reduce((acc, f) => acc + Number(f.size), 0)
      const invitesUsed = invitesAll.filter(i => i.used_at).length

      return json(c, 200, {
        users: users.length,
        folders: folders.length,
        files: files.length,
        total_storage_bytes: totalBytes,
        invites_total: invitesAll.length,
        invites_used: invitesUsed,
        invites_unused: invitesAll.length - invitesUsed,
      })
    })),

    get("/admin/audit", guard(async (c) => {
      const url = new URL(c.request.url)
      const event = url.searchParams.get("event")
      const userIdParam = url.searchParams.get("user_id")
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)))

      let q = from("audit_events")
        .leftJoin("users", raw("users.id = audit_events.user_id"))
        .select(
          "audit_events.id",
          "audit_events.user_id",
          "audit_events.event",
          "audit_events.metadata",
          "audit_events.ip",
          "audit_events.user_agent",
          "audit_events.created_at",
          raw("users.username AS username"),
          raw("users.email AS user_email"),
        )
        .orderBy("audit_events.created_at", "DESC")
        .limit(limit)

      if (event) q = q.where(qb => qb("audit_events.event").equals(event))
      if (userIdParam) {
        const uid = Number(userIdParam)
        if (!Number.isNaN(uid)) q = q.where(qb => qb("audit_events.user_id").equals(uid))
      }

      const rows = await db.all(q)
      return json(c, 200, rows)
    })),
  ]
}

import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, halt, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { randomToken } from "../util/token.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const ownerOnly = async (c: any) => {
  if (!c.assigns?.auth?.is_owner) {
    return halt(c, 403, { error: "Owner access required" })
  }
  return c
}

type InviteRequest = {
  id: number
  email: string
  name: string | null
  reason: string | null
  status: string
  processed_at: string | null
  processed_by: number | null
  created_at: string
}

export const adminRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }), ownerOnly)
  const authed = pipeline(requireAuth({ secret, db }), ownerOnly, parseJson)

  return [
    get("/admin/invite-requests", guard(async (c) => {
      const url = new URL(c.request.url)
      const status = url.searchParams.get("status") ?? "pending"
      const rows = await db.all(
        from("invite_requests")
          .where(q => status === "all" ? q("id").isNotNull() : q("status").equals(status))
          .orderBy("created_at", "DESC")
          .limit(200),
      )
      return json(c, 200, rows)
    })),

    post("/admin/invite-requests/:id/invite", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("invite_requests").where(q => q("id").equals(id)),
      ) as InviteRequest | null
      if (!row) return json(c, 404, { error: "Request not found" })
      if (row.status !== "pending") return json(c, 409, { error: `Already ${row.status}` })

      const existing = await db.one(
        from("invites")
          .where(q => q("email").ilike(row.email))
          .where(q => q("used_at").isNull())
          .select("token")
          .orderBy("created_at", "DESC")
          .limit(1),
      ) as { token: string } | null

      let inviteToken = existing?.token
      if (!inviteToken) {
        const tok = randomToken()
        const inserted = await db.execute(
          from("invites").insert({ token: tok, email: row.email, invited_by: userId }).returning("token"),
        ) as Array<{ token: string }>
        inviteToken = inserted[0]!.token
      }

      await db.execute(
        from("invite_requests").where(q => q("id").equals(id)).update({
          status: "invited",
          processed_at: raw("NOW()"),
          processed_by: userId,
        }),
      )

      return json(c, 200, {
        id,
        invite_token: inviteToken,
        email: row.email,
      })
    })),

    post("/admin/invite-requests/:id/dismiss", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("invite_requests").where(q => q("id").equals(id)),
      ) as InviteRequest | null
      if (!row) return json(c, 404, { error: "Request not found" })
      if (row.status !== "pending") return json(c, 409, { error: `Already ${row.status}` })

      await db.execute(
        from("invite_requests").where(q => q("id").equals(id)).update({
          status: "dismissed",
          processed_at: raw("NOW()"),
          processed_by: userId,
        }),
      )
      return json(c, 200, { dismissed: id })
    })),

    del("/admin/invite-requests/:id", guard(async (c) => {
      const id = Number(c.params.id)
      await db.execute(from("invite_requests").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),

    get("/admin/users", guard(async (c) => {
      const users = await db.all(
        from("users")
          .select("id", "username", "email", "name", "is_owner", "created_at")
          .orderBy("created_at", "DESC"),
      ) as Array<{ id: number; username: string; email: string; name: string; is_owner: boolean; created_at: string }>

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
      let q = from("invites").select("id", "token", "email", "invited_by", "used_at", "used_by", "created_at")
      if (filter === "unused") q = q.where(p => p("used_at").isNull())
      if (filter === "used") q = q.where(p => p("used_at").isNotNull())

      const rows = await db.all(q.orderBy("created_at", "DESC").limit(500)) as Array<{
        id: number
        token: string
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
      const requestsPending = await db.all(
        from("invite_requests").where(q => q("status").equals("pending")).select("id"),
      ) as Array<{ id: number }>

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
        requests_pending: requestsPending.length,
      })
    })),
  ]
}

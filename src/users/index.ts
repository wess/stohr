import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { hash, verify } from "@atlas/auth"
import { requireAuth } from "../auth/guard.ts"
import { drop } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authJti = (c: any): string | null => (c.assigns.auth as { jti?: string | null }).jti ?? null

export const userRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/me", guard(async (c) => {
      const userId = authId(c)
      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "email", "username", "name", "is_owner", "created_at"),
      )
      if (!user) return json(c, 404, { error: "User not found" })
      return json(c, 200, user)
    })),

    patch("/me", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { name?: string; email?: string; username?: string }
      const name = body.name?.trim()
      const email = body.email?.trim().toLowerCase()
      const usernameRaw = body.username?.trim()
      const username = usernameRaw ? normalizeUsername(usernameRaw) : undefined

      if (!name && !email && !username) return json(c, 422, { error: "Provide name, email, or username" })

      const updates: Record<string, unknown> = {}
      if (name) updates.name = name
      if (email) {
        if (!isEmail(email)) return json(c, 422, { error: "Invalid email format" })
        const existing = await db.one(
          from("users").where(q => q("email").equals(email)).select("id"),
        ) as { id: number } | null
        if (existing && existing.id !== userId) return json(c, 409, { error: "Email already in use" })
        updates.email = email
      }
      if (username) {
        if (!isValidUsername(username)) {
          return json(c, 422, { error: "Username must be 3-32 chars, lowercase letters, digits, and underscores" })
        }
        const existing = await db.one(
          from("users").where(q => q("username").equals(username)).select("id"),
        ) as { id: number } | null
        if (existing && existing.id !== userId) return json(c, 409, { error: "Username already in use" })
        updates.username = username
      }

      await db.execute(
        from("users").where(q => q("id").equals(userId)).update(updates),
      )

      const fresh = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "email", "username", "name", "is_owner", "created_at"),
      ) as { id: number; email: string; username: string; name: string; is_owner: boolean; created_at: string }

      const sess = await issueSession(db, fresh, secret, {
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      // Revoke prior sessions so identity changes invalidate them.
      await revokeAllSessions(db, userId, sess.jti)
      return json(c, 200, {
        id: fresh.id,
        email: fresh.email,
        username: fresh.username,
        name: fresh.name,
        is_owner: fresh.is_owner,
        created_at: fresh.created_at,
        token: sess.token,
      })
    })),

    post("/me/password", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { current_password?: string; new_password?: string; currentPassword?: string; newPassword?: string }
      const current = body.current_password ?? body.currentPassword
      const next = body.new_password ?? body.newPassword

      if (!current || !next) return json(c, 422, { error: "current_password and new_password required" })
      if (next.length < 8) return json(c, 422, { error: "New password must be at least 8 characters" })

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "password"),
      ) as { id: number; password: string } | null
      if (!user) return json(c, 404, { error: "User not found" })

      const ok = await verify(current, user.password)
      if (!ok) return json(c, 401, { error: "Current password is incorrect" })

      const hashed = await hash(next)
      await db.execute(
        from("users").where(q => q("id").equals(userId)).update({ password: hashed }),
      )

      const currentJti = authJti(c)
      const revoked = await revokeAllSessions(db, userId, currentJti ?? undefined)
      logEvent(db, {
        userId,
        event: "password.changed",
        metadata: { revoked_other_sessions: revoked },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { ok: true, revoked_other_sessions: revoked })
    })),

    del("/me", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { password?: string }
      if (!body.password) return json(c, 422, { error: "password required" })

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "password"),
      ) as { id: number; password: string } | null
      if (!user) return json(c, 404, { error: "User not found" })

      const ok = await verify(body.password, user.password)
      if (!ok) return json(c, 401, { error: "Password is incorrect" })

      const keys = await db.all(
        from("files").where(q => q("user_id").equals(userId)).select("storage_key"),
      ) as Array<{ storage_key: string }>

      await db.execute(from("users").where(q => q("id").equals(userId)).del())

      await Promise.allSettled(keys.map(k => drop(store, k.storage_key)))

      return json(c, 200, { deleted: true })
    })),

    get("/users/search", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const qParam = (url.searchParams.get("q") ?? "").trim()
      if (!qParam) return json(c, 200, [])
      const pattern = `%${qParam.replace(/[%_]/g, m => `\\${m}`)}%`
      const rows = await db.all(
        from("users")
          .where(q =>
            q.or(
              q("username").ilike(pattern),
              q("email").ilike(pattern),
              q("name").ilike(pattern),
            ),
          )
          .select("id", "username", "name")
          .orderBy("username", "ASC")
          .limit(11),
      ) as Array<{ id: number; username: string; name: string }>
      return json(c, 200, rows.filter(r => r.id !== userId).slice(0, 10))
    })),

    get("/u/:username", guard(async (c) => {
      const username = normalizeUsername(c.params.username)
      const row = await db.one(
        from("users").where(q => q("username").equals(username)).select("id", "username", "name"),
      )
      if (!row) return json(c, 404, { error: "User not found" })
      return json(c, 200, row)
    })),
  ]
}

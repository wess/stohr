import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { hash, verify } from "@atlas/auth"
import { requireAuth } from "../auth/guard.ts"
import type { StorageHandle } from "../storage/index.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import type { Emailer } from "../email/index.ts"
import { scheduleDeletion } from "../auth/deletion.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authJti = (c: any): string | null => (c.assigns.auth as { jti?: string | null }).jti ?? null

export const userRoutes = (db: Connection, secret: string, _store: StorageHandle, emailer: Emailer, appUrl: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)
  // Routes that change credentials or destroy the account must reject OAuth
  // access tokens — only first-party (web/mobile JWT or PAT) callers allowed.
  const protectedAuthed = pipeline(requireAuth({ secret, db, noOAuth: true }), parseJson)

  return [
    get("/me", guard(async (c) => {
      const userId = authId(c)
      const user = await db.one(
        from("users")
          .where(q => q("id").equals(userId))
          .select("id", "email", "username", "name", "is_owner", "discoverable", "created_at"),
      )
      if (!user) return json(c, 404, { error: "User not found" })
      return json(c, 200, user)
    })),

    patch("/me", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as {
        name?: string; email?: string; username?: string
        discoverable?: boolean
      }
      const name = body.name?.trim()
      const email = body.email?.trim().toLowerCase()
      const usernameRaw = body.username?.trim()
      const username = usernameRaw ? normalizeUsername(usernameRaw) : undefined
      const discoverable = typeof body.discoverable === "boolean" ? body.discoverable : undefined

      if (!name && !email && !username && discoverable === undefined) {
        return json(c, 422, { error: "Provide name, email, username, or discoverable" })
      }

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
      if (discoverable !== undefined) updates.discoverable = discoverable

      await db.execute(
        from("users").where(q => q("id").equals(userId)).update(updates),
      )

      const fresh = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "email", "username", "name", "is_owner", "discoverable", "created_at"),
      ) as { id: number; email: string; username: string; name: string; is_owner: boolean; discoverable: boolean; created_at: string }

      // Identity changes (email/username) invalidate every session — the JWT
      // payload carries those claims. A privacy-only toggle (discoverable)
      // doesn't, so don't churn the user's tokens for it.
      const identityChanged = !!email || !!username || !!name
      const out: Record<string, unknown> = {
        id: fresh.id,
        email: fresh.email,
        username: fresh.username,
        name: fresh.name,
        is_owner: fresh.is_owner,
        discoverable: fresh.discoverable,
        created_at: fresh.created_at,
      }
      if (identityChanged) {
        const sess = await issueSession(db, fresh, secret, {
          ip: clientIp(c.request),
          userAgent: userAgent(c.request),
        })
        await revokeAllSessions(db, userId, sess.jti)
        out.token = sess.token
      }
      return json(c, 200, out)
    })),

    post("/me/password", protectedAuthed(async (c) => {
      const userId = authId(c)
      const body = c.body as { current_password?: string; new_password?: string; currentPassword?: string; newPassword?: string }
      const current = body.current_password ?? body.currentPassword
      const next = body.new_password ?? body.newPassword

      if (!current || !next) return json(c, 422, { error: "current_password and new_password required" })
      if (next.length < 8) return json(c, 422, { error: "New password must be at least 8 characters" })

      // Throttle bcrypt verify on user-controlled input — prevents a stolen
      // session from CPU-DoSing the API by hammering wrong currents.
      const rate = await checkRate(db, `pwchange:user:${userId}`, 10, 900)
      if (!rate.ok) {
        return json(c, 429, {
          error: "Too many password change attempts. Try again later.",
          retry_after: rate.retryAfterSeconds,
        })
      }

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

    del("/me", protectedAuthed(async (c) => {
      const userId = authId(c)
      const body = c.body as { password?: string }
      if (!body.password) return json(c, 422, { error: "password required" })

      // Same throttle as /me/password — bcrypt verify is CPU-expensive.
      const rate = await checkRate(db, `pwdelete:user:${userId}`, 5, 900)
      if (!rate.ok) {
        return json(c, 429, {
          error: "Too many delete attempts. Try again later.",
          retry_after: rate.retryAfterSeconds,
        })
      }

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("id", "email", "name", "password", "deleted_at"),
      ) as { id: number; email: string; name: string; password: string; deleted_at: string | null } | null
      if (!user) return json(c, 404, { error: "User not found" })
      if (user.deleted_at) {
        return json(c, 409, { error: "Account is already scheduled for deletion. Check your email for the cancel link." })
      }

      const ok = await verify(body.password, user.password)
      if (!ok) return json(c, 401, { error: "Password is incorrect" })

      // Soft-delete: 24h grace window, plaintext cancel token emailed once.
      // The actual purge (DB rows + storage objects) happens on the periodic
      // sweep after the grace window expires.
      await scheduleDeletion(db, emailer, appUrl, user, {
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      // Kill every session — the user must explicitly click the cancel link
      // (or wait for purge) to use the account again.
      await revokeAllSessions(db, userId)

      return json(c, 200, {
        scheduled: true,
        message: "Your account is scheduled for deletion. Check your email for a cancel link if you change your mind. The account will be permanently deleted in 24 hours.",
      })
    })),

    get("/users/search", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const qParam = (url.searchParams.get("q") ?? "").trim()
      if (!qParam) return json(c, 200, [])
      const pattern = `%${qParam.replace(/[%_]/g, m => `\\${m}`)}%`
      // Email is intentionally NOT searchable — substring queries on the
      // email column would let any authenticated user enumerate addresses
      // (e.g. "@acme.com"). Username and display name are public-by-design.
      const rows = await db.all(
        from("users")
          .where(q => q.or(q("username").ilike(pattern), q("name").ilike(pattern)))
          .where(q => q("deleted_at").isNull())
          .where(q => q("discoverable").equals(true))
          .select("id", "username", "name")
          .orderBy("username", "ASC")
          .limit(11),
      ) as Array<{ id: number; username: string; name: string }>
      return json(c, 200, rows.filter(r => r.id !== userId).slice(0, 10))
    })),

    get("/u/:username", guard(async (c) => {
      const userId = authId(c)
      const username = normalizeUsername(c.params.username)
      const row = await db.one(
        from("users")
          .where(q => q("username").equals(username))
          .select("id", "username", "name", "discoverable", "deleted_at"),
      ) as { id: number; username: string; name: string; discoverable: boolean; deleted_at: string | null } | null
      if (!row || row.deleted_at) return json(c, 404, { error: "User not found" })
      // Self-lookup always works — otherwise a user couldn't see their own
      // public profile. For everyone else, respect the discoverable toggle.
      if (!row.discoverable && row.id !== userId) {
        return json(c, 404, { error: "User not found" })
      }
      return json(c, 200, { id: row.id, username: row.username, name: row.name })
    })),
  ]
}

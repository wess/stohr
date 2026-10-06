import { hash, verify } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, patch, pipeline, post } from "@atlas/server"
import { scheduleDeletion } from "../auth/deletion.ts"
import { requireAuth } from "../auth/guard.ts"
import type { Emailer } from "../email/index.ts"
import { logEvent } from "../security/audit.ts"
import { revokeCredentials } from "../security/credentials.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import type { StorageHandle } from "../storage/index.ts"
import { requestBaseUrl, teamFor } from "../teams/request.ts"
import { computeUsage } from "../usage/index.ts"
import { parseJson } from "../util/json/index.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authJti = (c: any): string | null => (c.assigns.auth as { jti?: string | null }).jti ?? null

export const userRoutes = (db: Connection, secret: string, _store: StorageHandle, emailer: Emailer, appUrl: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  // Routes that change identity or credentials, or destroy the account, must
  // reject OAuth access tokens — only first-party (web/mobile JWT or PAT)
  // callers allowed.
  const protectedAuthed = pipeline(requireAuth({ secret, db, noOAuth: true }), parseJson)

  return [
    get(
      "/me",
      guard(async c => {
        const userId = authId(c)
        const user = (await db.one(
          from("users")
            .where(q => q("id").equals(userId))
            .select("id", "email", "username", "name", "is_owner", "team_admin", "discoverable", "created_at"),
        )) as Record<string, unknown> | null
        if (!user) return json(c, 404, { error: "User not found" })
        // requireAuth already proved the user belongs to the host's team
        const { team, isRoot } = teamFor(c.request)
        return json(c, 200, {
          ...user,
          team: { id: team.id, slug: team.slug, name: team.name },
          is_root: isRoot,
        })
      }),
    ),

    // Storage usage + the per-user cap. `quota_bytes` of 0 means unlimited;
    // the cap is set by the owner in Admin → Users.
    get(
      "/me/usage",
      guard(async c => {
        const userId = authId(c)
        const user = (await db.one(
          from("users")
            .where(q => q("id").equals(userId))
            .select("storage_quota_bytes"),
        )) as { storage_quota_bytes: number | string } | null
        if (!user) return json(c, 404, { error: "User not found" })
        const usage = await computeUsage(db, userId)
        return json(c, 200, {
          quota_bytes: Number(user.storage_quota_bytes),
          used_bytes: usage.total,
          active_bytes: usage.active,
          trash_bytes: usage.trash,
          version_bytes: usage.versions,
        })
      }),
    ),

    // Email and username are the account's login identities, so changing
    // them is a credential operation: first-party callers only, current
    // password required, and the replacement JWT goes only to a session.
    patch(
      "/me",
      protectedAuthed(async c => {
        const userId = authId(c)
        const auth = c.assigns.auth as { via?: string }
        const body = c.body as {
          name?: string
          email?: string
          username?: string
          discoverable?: boolean
          current_password?: string
          currentPassword?: string
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
        if (email && !isEmail(email)) return json(c, 422, { error: "Invalid email format" })
        if (username && !isValidUsername(username)) {
          return json(c, 422, { error: "Username must be 3-32 chars, lowercase letters, digits, and underscores" })
        }
        if (discoverable !== undefined) updates.discoverable = discoverable

        if (email || username) {
          const current = body.current_password ?? body.currentPassword
          if (!current) return json(c, 422, { error: "current_password is required to change email or username" })

          // Same throttle as /me/password — a stolen session gets a bounded
          // number of guesses at the password that would let it take over
          // the account's login identity. The password gate also sits in
          // front of the uniqueness checks below: emails and usernames are
          // unique across every team, so the 409 would otherwise tell any
          // signed-in user whether an address exists on another tenant.
          const rate = await checkRate(db, `profile:user:${userId}`, 10, 900)
          if (!rate.ok) {
            return json(c, 429, { error: "Too many attempts. Try again later.", retry_after: rate.retryAfterSeconds })
          }
          const row = (await db.one(
            from("users")
              .where(q => q("id").equals(userId))
              .select("password"),
          )) as { password: string } | null
          if (!row) return json(c, 404, { error: "User not found" })
          const ok = await verify(current, row.password).catch(() => false)
          if (!ok) return json(c, 401, { error: "Current password is incorrect" })
        }

        if (email) {
          const existing = (await db.one(
            from("users")
              .where(q => q("email").equals(email))
              .select("id"),
          )) as { id: number } | null
          if (existing && existing.id !== userId) return json(c, 409, { error: "Email already in use" })
          updates.email = email
        }
        if (username) {
          const existing = (await db.one(
            from("users")
              .where(q => q("username").equals(username))
              .select("id"),
          )) as { id: number } | null
          if (existing && existing.id !== userId) return json(c, 409, { error: "Username already in use" })
          updates.username = username
        }

        await db.transaction(async tx => {
          await tx.execute({ text: "SELECT id FROM users WHERE id = $1 FOR UPDATE", values: [userId] })
          await tx.execute(
            from("users")
              .where(q => q("id").equals(userId))
              .update(updates),
          )
          if (email || username) await revokeCredentials(tx, userId)
        })

        const fresh = (await db.one(
          from("users")
            .where(q => q("id").equals(userId))
            .select("id", "email", "username", "name", "is_owner", "discoverable", "created_at"),
        )) as {
          id: number
          email: string
          username: string
          name: string
          is_owner: boolean
          discoverable: boolean
          created_at: string
        }

        // Identity changes (email/username/name) invalidate every session —
        // the JWT payload carries those claims. A privacy-only toggle
        // (discoverable) doesn't, so don't churn the user's tokens for it.
        // Only a session caller gets a replacement: a PAT has no session to
        // replace, and handing one a JWT would upgrade it to a first-party
        // login.
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
          if (auth.via === "session") {
            const sess = await issueSession(db, fresh, secret, {
              ip: clientIp(c.request),
              userAgent: userAgent(c.request),
            })
            await revokeAllSessions(db, userId, sess.jti)
            out.token = sess.token
          } else {
            await revokeAllSessions(db, userId)
          }
        }
        return json(c, 200, out)
      }),
    ),

    post(
      "/me/password",
      protectedAuthed(async c => {
        const userId = authId(c)
        const body = c.body as {
          current_password?: string
          new_password?: string
          currentPassword?: string
          newPassword?: string
        }
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

        const user = (await db.one(
          from("users")
            .where(q => q("id").equals(userId))
            .select("id", "password"),
        )) as { id: number; password: string } | null
        if (!user) return json(c, 404, { error: "User not found" })

        const ok = await verify(current, user.password)
        if (!ok) return json(c, 401, { error: "Current password is incorrect" })

        const hashed = await hash(next)
        const currentJti = authJti(c)
        const completed = await db.transaction(async tx => {
          await tx.execute({ text: "SELECT id FROM users WHERE id = $1 FOR UPDATE", values: [userId] })
          const changed = (await tx.execute(
            from("users")
              .where(q => q("id").equals(userId))
              .where(q => q("password").equals(user.password))
              .update({ password: hashed })
              .returning("id"),
          )) as Array<{ id: number }>
          if (!changed.length) return null
          await revokeCredentials(tx, userId)
          return { revoked: await revokeAllSessions(tx, userId, currentJti ?? undefined) }
        })
        if (!completed) return json(c, 401, { error: "Current password is incorrect" })
        const { revoked } = completed
        logEvent(db, {
          userId,
          event: "password.changed",
          metadata: { revoked_other_sessions: revoked },
          ip: clientIp(c.request),
          userAgent: userAgent(c.request),
        })
        return json(c, 200, { ok: true, revoked_other_sessions: revoked })
      }),
    ),

    del(
      "/me",
      protectedAuthed(async c => {
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

        const user = (await db.one(
          from("users")
            .where(q => q("id").equals(userId))
            .select("id", "email", "name", "password", "deleted_at"),
        )) as { id: number; email: string; name: string; password: string; deleted_at: string | null } | null
        if (!user) return json(c, 404, { error: "User not found" })
        if (user.deleted_at) {
          return json(c, 409, {
            error: "Account is already scheduled for deletion. Check your email for the cancel link.",
          })
        }

        const ok = await verify(body.password, user.password)
        if (!ok) return json(c, 401, { error: "Password is incorrect" })

        // Soft-delete: 24h grace window, plaintext cancel token emailed once.
        // The actual purge (DB rows + storage objects) happens on the periodic
        // sweep after the grace window expires. The cancel link lands on the
        // host the account lives on.
        await scheduleDeletion(db, emailer, requestBaseUrl(c.request, appUrl), user, {
          ip: clientIp(c.request),
          userAgent: userAgent(c.request),
        })
        // Kill every session — the user must explicitly click the cancel link
        // (or wait for purge) to use the account again.
        await revokeAllSessions(db, userId)

        return json(c, 200, {
          scheduled: true,
          message:
            "Your account is scheduled for deletion. Check your email for a cancel link if you change your mind. The account will be permanently deleted in 24 hours.",
        })
      }),
    ),

    get(
      "/users/search",
      guard(async c => {
        const userId = authId(c)
        const url = new URL(c.request.url)
        const qParam = (url.searchParams.get("q") ?? "").trim()
        if (!qParam) return json(c, 200, [])
        const pattern = `%${qParam.replace(/[%_]/g, m => `\\${m}`)}%`
        // Email is intentionally NOT searchable — substring queries on the
        // email column would let any authenticated user enumerate addresses
        // (e.g. "@acme.com"). Username and display name are public-by-design,
        // inside the caller's team only.
        const rows = (await db.all(
          from("users")
            .where(q => q.or(q("username").ilike(pattern), q("name").ilike(pattern)))
            .where(q => q("team_id").equals(teamFor(c.request).team.id))
            .where(q => q("deleted_at").isNull())
            .where(q => q("discoverable").equals(true))
            .select("id", "username", "name")
            .orderBy("username", "ASC")
            .limit(11),
        )) as Array<{ id: number; username: string; name: string }>
        return json(c, 200, rows.filter(r => r.id !== userId).slice(0, 10))
      }),
    ),

    get(
      "/u/:username",
      guard(async c => {
        const userId = authId(c)
        const username = normalizeUsername(c.params.username)
        // another team's user is not found, same as a nonexistent one
        const row = (await db.one(
          from("users")
            .where(q => q("username").equals(username))
            .where(q => q("team_id").equals(teamFor(c.request).team.id))
            .select("id", "username", "name", "discoverable", "deleted_at"),
        )) as { id: number; username: string; name: string; discoverable: boolean; deleted_at: string | null } | null
        if (!row || row.deleted_at) return json(c, 404, { error: "User not found" })
        // Self-lookup always works — otherwise a user couldn't see their own
        // public profile. For everyone else, respect the discoverable toggle.
        if (!row.discoverable && row.id !== userId) {
          return json(c, 404, { error: "User not found" })
        }
        return json(c, 200, { id: row.id, username: row.username, name: row.name })
      }),
    ),
  ]
}

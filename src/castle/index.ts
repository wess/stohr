// Castle integration: machine-to-machine endpoints for centrally-managed
// user provisioning. Opt-in: gated by the CASTLE_ADMIN_TOKEN env var.
// When unset, the routes simply aren't mounted (see server.ts) and Stohr
// behaves exactly as it did before this module landed.
//
// Castle provisions the instance owner's own accounts: the routes exist on
// the root host only and every lookup stays inside the root team, so a
// tenant user with a matching email is never touched.

import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, pipeline, post } from "@atlas/server"
import { resolvePendingCollabs } from "../auth/index.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { revokeAllSessions } from "../security/sessions.ts"
import { rootOnly } from "../teams/guards.ts"
import { ROOT_TEAM_ID } from "../teams/resolve.ts"
import { parseJson } from "../util/json/index.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"
import { requireCastleToken } from "./guard.ts"

type UserRow = { id: number; password: string }

const argonRe = /^\$argon2(id|i|d)\$/

export const castleRoutes = (db: Connection, adminToken: string) => {
  if (!adminToken) return []
  const guard = pipeline(rootOnly, requireCastleToken(adminToken), parseJson)
  const guardNoBody = pipeline(rootOnly, requireCastleToken(adminToken))

  return [
    get(
      "/castle/health",
      guardNoBody(async c => json(c, 200, { ok: true, service: "stohr" })),
    ),

    // Upsert by email, falling back to username when only username matches.
    // Idempotent: re-sending the same payload produces the same row state.
    // Session revocation runs only when the stored hash actually changes,
    // so re-syncs don't kick the user out unnecessarily.
    post(
      "/castle/users",
      guard(async c => {
        const body = c.body as {
          email?: string
          username?: string
          name?: string
          password_hash?: string
          is_owner?: boolean
        }
        const email = body.email?.trim().toLowerCase()
        const usernameRaw = body.username?.trim()
        const name = body.name?.trim()
        const passwordHash = body.password_hash
        // Only set role when the caller explicitly opts in. Castle is an
        // identity provisioner, not a role authority — owner is a Stohr-side
        // concept that the local admin manages from the Admin UI.
        const isOwnerSpecified = typeof body.is_owner === "boolean"
        const isOwner = body.is_owner === true

        if (!email || !usernameRaw || !name || !passwordHash) {
          return json(c, 422, { error: "email, username, name, password_hash required" })
        }
        if (!isEmail(email)) return json(c, 422, { error: "invalid email" })
        const username = normalizeUsername(usernameRaw)
        if (!isValidUsername(username)) {
          return json(c, 422, { error: "username must be 3-32 chars, lowercase letters, digits, underscores" })
        }
        if (!argonRe.test(passwordHash)) {
          return json(c, 422, { error: "password_hash must be an argon2 hash" })
        }

        const byEmail = (await db.one(
          from("users")
            .where(q => q("email").equals(email))
            .where(q => q("team_id").equals(ROOT_TEAM_ID))
            .select("id", "password"),
        )) as UserRow | null
        const target =
          byEmail ??
          ((await db.one(
            from("users")
              .where(q => q("username").equals(username))
              .where(q => q("team_id").equals(ROOT_TEAM_ID))
              .select("id", "password"),
          )) as UserRow | null)

        let created = false
        let userId: number
        let revokedSessions = 0

        // emails and usernames are unique across teams: an address a tenant
        // account already holds is neither updated nor re-created here
        if (!target) {
          const elsewhere = await db.one({
            text: "SELECT id FROM users WHERE email = $1 OR username = $2 LIMIT 1",
            values: [email, username],
          })
          if (elsewhere) return json(c, 409, { error: "email or username is already in use" })
        }

        if (target) {
          userId = target.id
          const passwordChanged = target.password !== passwordHash
          const update: Record<string, unknown> = {
            email,
            username,
            name,
            password: passwordHash,
          }
          if (isOwnerSpecified) update.is_owner = isOwner
          await db.execute(
            from("users")
              .where(q => q("id").equals(target.id))
              .update(update),
          )
          if (passwordChanged) {
            revokedSessions = await revokeAllSessions(db, target.id)
            logEvent(db, {
              userId: target.id,
              event: "castle.password_changed",
              ip: clientIp(c.request),
              userAgent: userAgent(c.request),
              metadata: { revoked_sessions: revokedSessions },
            })
          }
        } else {
          const inserted = (await db.execute(
            from("users")
              .insert({
                email,
                username,
                name,
                password: passwordHash,
                is_owner: isOwnerSpecified ? isOwner : false,
                team_id: ROOT_TEAM_ID,
              })
              .returning("id"),
          )) as Array<{ id: number }>
          userId = inserted[0]!.id
          created = true
          await resolvePendingCollabs(db, userId, email)
          logEvent(db, {
            userId,
            event: "castle.user_created",
            ip: clientIp(c.request),
            userAgent: userAgent(c.request),
          })
        }

        return json(c, created ? 201 : 200, {
          id: userId,
          email,
          username,
          name,
          created,
          revoked_sessions: revokedSessions,
        })
      }),
    ),

    del(
      "/castle/users/by-email/:email",
      guardNoBody(async c => {
        const email = decodeURIComponent(c.params.email ?? "").toLowerCase()
        if (!email) return json(c, 422, { error: "missing email" })
        const row = (await db.one(
          from("users")
            .where(q => q("email").equals(email))
            .where(q => q("team_id").equals(ROOT_TEAM_ID))
            .select("id"),
        )) as { id: number } | null
        if (!row) return json(c, 404, { error: "user not found" })
        // Hard-delete: bypasses the scheduleDeletion grace window because the
        // central admin (Castle) is making an explicit, audited choice.
        // ON DELETE CASCADE on sessions, collaborations etc. handles cleanup.
        await db.execute(
          from("users")
            .where(q => q("id").equals(row.id))
            .del(),
        )
        logEvent(db, {
          userId: row.id,
          event: "castle.user_deleted",
          ip: clientIp(c.request),
          userAgent: userAgent(c.request),
        })
        return json(c, 200, { ok: true, deleted: row.id })
      }),
    ),
  ]
}

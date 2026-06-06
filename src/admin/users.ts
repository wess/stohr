import { randomBytes } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { hashToken, requireAuth } from "../auth/guard.ts"
import type { Emailer } from "../email/index.ts"
import { passwordResetEmail } from "../email/templates/password.ts"
import { broadcastSystem, sendSystem } from "../messages/system.ts"
import { logEvent } from "../security/audit.ts"
import { ownerOnly } from "../security/owner.ts"
import { revokeAllSessions } from "../security/sessions.ts"
import { randomToken, sha256Hex } from "../util/token.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const PWR_PREFIX = "stohr_pwr_"
const RESET_TTL_SECONDS = 60 * 60

type UserDetail = {
  id: number
  username: string
  email: string
  name: string
  is_owner: boolean
  storage_quota_bytes: number | string
  totp_enabled: boolean
  suspended_at: string | null
  suspended_reason: string | null
  suspended_by: number | null
  deleted_at: string | null
  created_at: string
}

export const adminUserRoutes = (db: Connection, secret: string, emailer: Emailer, appUrl: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get(
      "/admin/users/:id",
      guard(async c => {
        const id = Number(c.params.id)
        const user = (await db.one(
          from("users")
            .where(q => q("id").equals(id))
            .select(
              "id",
              "username",
              "email",
              "name",
              "is_owner",
              "storage_quota_bytes",
              "totp_enabled",
              "suspended_at",
              "suspended_reason",
              "suspended_by",
              "deleted_at",
              "created_at",
            ),
        )) as UserDetail | null
        if (!user) return json(c, 404, { error: "User not found" })

        const usage = (await db.one({
          text: `
          SELECT
            COALESCE(SUM(size), 0)::bigint AS bytes,
            COUNT(*)::int AS files
          FROM files
          WHERE user_id = $1 AND deleted_at IS NULL
        `,
          values: [id],
        })) as { bytes: string; files: number }

        const sessionCount = (await db.one({
          text: `SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
          values: [id],
        })) as { n: number }

        return json(c, 200, {
          ...user,
          storage_quota_bytes: Number(user.storage_quota_bytes),
          storage_bytes: Number(usage.bytes),
          file_count: usage.files,
          active_sessions: sessionCount.n,
        })
      }),
    ),

    patch(
      "/admin/users/:id",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = c.body as { name?: string; email?: string; username?: string }
        const update: Record<string, unknown> = {}

        if (body.name !== undefined) {
          const name = body.name.trim()
          if (!name) return json(c, 422, { error: "name must not be empty" })
          update.name = name
        }
        if (body.email !== undefined) {
          const email = body.email.trim().toLowerCase()
          if (!isEmail(email)) return json(c, 422, { error: "Invalid email format" })
          const taken = await db.one(
            from("users")
              .where(q => q("email").equals(email))
              .where(q => q("id").notEquals(id))
              .select("id"),
          )
          if (taken) return json(c, 409, { error: "Email already in use" })
          update.email = email
        }
        if (body.username !== undefined) {
          const username = normalizeUsername(body.username)
          if (!isValidUsername(username))
            return json(c, 422, { error: "Username must be 3-32 chars, lowercase letters, digits, and underscores" })
          const taken = await db.one(
            from("users")
              .where(q => q("username").equals(username))
              .where(q => q("id").notEquals(id))
              .select("id"),
          )
          if (taken) return json(c, 409, { error: "Username already in use" })
          update.username = username
        }
        if (Object.keys(update).length === 0) return json(c, 422, { error: "Nothing to update" })

        const exists = await db.one(
          from("users")
            .where(q => q("id").equals(id))
            .select("id"),
        )
        if (!exists) return json(c, 404, { error: "User not found" })

        await db.execute(
          from("users")
            .where(q => q("id").equals(id))
            .update(update),
        )
        logEvent(db, { userId, event: "admin.user_edited", metadata: { target: id, fields: Object.keys(update) } })
        return json(c, 200, { id, updated: Object.keys(update) })
      }),
    ),

    post(
      "/admin/users/:id/suspend",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = c.body as { reason?: string }
        if (id === userId) return json(c, 422, { error: "Cannot suspend yourself" })
        const target = (await db.one(
          from("users")
            .where(q => q("id").equals(id))
            .select("id", "is_owner", "suspended_at"),
        )) as { id: number; is_owner: boolean; suspended_at: string | null } | null
        if (!target) return json(c, 404, { error: "User not found" })
        if (target.is_owner) return json(c, 422, { error: "Cannot suspend another owner" })
        if (target.suspended_at) return json(c, 409, { error: "User is already suspended" })

        await db.execute(
          from("users")
            .where(q => q("id").equals(id))
            .update({
              suspended_at: raw("NOW()"),
              suspended_reason: body.reason?.trim() ?? null,
              suspended_by: userId,
            }),
        )
        await revokeAllSessions(db, id)

        void sendSystem(
          db,
          id,
          "Your account has been suspended",
          body.reason
            ? `An owner of this Stohr instance has suspended your account.\n\nReason given:\n${body.reason}\n\nContact the owner to restore access.`
            : "An owner of this Stohr instance has suspended your account. Contact the owner to restore access.",
        )

        logEvent(db, { userId, event: "admin.user_suspended", metadata: { target: id, reason: body.reason ?? null } })
        return json(c, 200, { id, suspended: true })
      }),
    ),

    post(
      "/admin/users/:id/unsuspend",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const target = (await db.one(
          from("users")
            .where(q => q("id").equals(id))
            .select("id", "suspended_at"),
        )) as { id: number; suspended_at: string | null } | null
        if (!target) return json(c, 404, { error: "User not found" })
        if (!target.suspended_at) return json(c, 409, { error: "User is not suspended" })

        await db.execute(
          from("users")
            .where(q => q("id").equals(id))
            .update({
              suspended_at: null,
              suspended_reason: null,
              suspended_by: null,
            }),
        )
        void sendSystem(
          db,
          id,
          "Your account has been restored",
          "Your account is active again. You can sign in normally now.",
        )
        logEvent(db, { userId, event: "admin.user_unsuspended", metadata: { target: id } })
        return json(c, 200, { id, suspended: false })
      }),
    ),

    // Mint a password-reset token and email it to the user. If email is
    // disabled (no RESEND_API_KEY), the owner gets the URL back in the
    // response so they can hand it over out-of-band.
    post(
      "/admin/users/:id/reset-password",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const target = (await db.one(
          from("users")
            .where(q => q("id").equals(id))
            .select("id", "name", "email", "deleted_at"),
        )) as { id: number; name: string; email: string; deleted_at: string | null } | null
        if (!target || target.deleted_at) return json(c, 404, { error: "User not found" })

        const fullToken = `${PWR_PREFIX}${randomBytes(32).toString("base64url")}`
        const tokenHash = hashToken(fullToken)
        const expiresAt = new Date(Date.now() + RESET_TTL_SECONDS * 1000)
        await db.execute(
          from("password_resets").insert({
            user_id: target.id,
            token_hash: tokenHash,
            expires_at: expiresAt,
            ip: null,
          }),
        )

        const resetUrl = `${appUrl.replace(/\/$/, "")}/password/reset?token=${encodeURIComponent(fullToken)}`
        const tpl = passwordResetEmail({ name: target.name, resetUrl })
        const sent = await emailer.send({
          to: target.email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        })

        logEvent(db, { userId, event: "admin.password_reset_issued", metadata: { target: id, emailed: !!sent } })

        return json(c, 200, {
          id,
          emailed: !!sent,
          // The owner sees the URL only when delivery wasn't possible —
          // this avoids handing the token to a different admin tab unless
          // it's actually needed.
          reset_url: sent ? null : resetUrl,
        })
      }),
    ),

    post(
      "/admin/users/:id/message",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = c.body as { subject?: string; body?: string }
        const subject = body.subject?.trim()
        const messageBody = body.body?.trim()
        if (!subject || !messageBody) return json(c, 422, { error: "subject and body are required" })
        const target = (await db.one(
          from("users")
            .where(q => q("id").equals(id))
            .where(q => q("deleted_at").isNull())
            .select("id"),
        )) as { id: number } | null
        if (!target) return json(c, 404, { error: "User not found" })
        const messageId = await sendSystem(db, id, subject, messageBody)
        logEvent(db, { userId, event: "admin.message_sent", metadata: { target: id, message_id: messageId } })
        return json(c, 201, { id: messageId })
      }),
    ),

    post(
      "/admin/broadcast",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as { subject?: string; body?: string }
        const subject = body.subject?.trim()
        const messageBody = body.body?.trim()
        if (!subject || !messageBody) return json(c, 422, { error: "subject and body are required" })
        const delivered = await broadcastSystem(db, subject, messageBody)
        logEvent(db, { userId, event: "admin.broadcast", metadata: { delivered } })
        return json(c, 201, { delivered })
      }),
    ),

    // Create a targeted invite (with optional email binding) from the
    // admin UI. The /invites endpoint covers per-user invites; this one
    // is for the owner managing access centrally.
    post(
      "/admin/invites",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as { email?: string }
        const emailRaw = body.email?.trim().toLowerCase()
        if (emailRaw && !isEmail(emailRaw)) return json(c, 422, { error: "Invalid email format" })
        const email = emailRaw || null
        const token = randomToken()
        const rows = (await db.execute(
          from("invites")
            .insert({ token_hash: sha256Hex(token), email, invited_by: userId })
            .returning("id", "email", "created_at"),
        )) as Array<{ id: number; email: string | null; created_at: string }>
        return json(c, 201, { ...rows[0], token })
      }),
    ),
  ]
}

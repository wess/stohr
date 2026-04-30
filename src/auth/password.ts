import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import { hash } from "@atlas/auth"
import { randomBytes } from "node:crypto"
import { hashToken } from "./guard.ts"
import { revokeAllSessions } from "../security/sessions.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { isEmail } from "../util/username.ts"
import type { Emailer } from "../email/index.ts"
import { passwordResetEmail } from "../email/templates/password.ts"

export const PWR_PREFIX = "stohr_pwr_"
const TTL_SECONDS = 60 * 60 // 1 hour

const generateResetToken = (): string =>
  `${PWR_PREFIX}${randomBytes(32).toString("base64url")}`

export const passwordRoutes = (db: Connection, emailer: Emailer, appUrl: string) => {
  const api = pipeline(parseJson)

  return [
    post("/password/forgot", api(async (c) => {
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)
      const body = c.body as { email?: string }
      const email = body.email?.trim().toLowerCase() ?? ""

      // Generic 200 response — never disclose whether the email exists.
      const ok = json(c, 200, { ok: true, message: "If that email is on file, we sent a reset link." })

      if (!email || !isEmail(email)) return ok

      const ipRate = await checkRate(db, `pwr:ip:${ip}`, 30, 3600)
      if (!ipRate.ok) {
        logEvent(db, { event: "password.reset_rate_limited", metadata: { scope: "ip" }, ip, userAgent: ua })
        return ok
      }
      const emailRate = await checkRate(db, `pwr:email:${email}`, 5, 3600)
      if (!emailRate.ok) {
        logEvent(db, { event: "password.reset_rate_limited", metadata: { scope: "email", email }, ip, userAgent: ua })
        return ok
      }

      const user = await db.one(
        from("users")
          .where(q => q("email").equals(email))
          .where(q => q("deleted_at").isNull())
          .select("id", "name", "email"),
      ) as { id: number; name: string; email: string } | null
      // Don't email a reset link to a soft-deleted account — and stay silent
      // either way to avoid leaking which addresses are scheduled for deletion.
      if (!user) return ok

      const fullToken = generateResetToken()
      const tokenHash = hashToken(fullToken)
      const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000)

      await db.execute(
        from("password_resets").insert({
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
          ip,
        }),
      )

      const resetUrl = `${appUrl.replace(/\/$/, "")}/password/reset?token=${encodeURIComponent(fullToken)}`
      const tpl = passwordResetEmail({ name: user.name, resetUrl })
      const sent = await emailer.send({
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      })

      logEvent(db, {
        userId: user.id,
        event: "password.reset_requested",
        metadata: { email_ok: sent.ok, email_id: sent.ok ? sent.id ?? null : null, error: sent.ok ? null : sent.error },
        ip,
        userAgent: ua,
      })

      return ok
    })),

    post("/password/reset", api(async (c) => {
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)
      const body = c.body as { token?: string; new_password?: string; newPassword?: string }
      const tokenRaw = body.token?.trim() ?? ""
      const newPassword = body.new_password ?? body.newPassword ?? ""

      if (!tokenRaw || !tokenRaw.startsWith(PWR_PREFIX)) {
        return json(c, 400, { error: "Invalid or expired reset link" })
      }
      if (!newPassword || newPassword.length < 8) {
        return json(c, 422, { error: "Password must be at least 8 characters" })
      }

      const ipRate = await checkRate(db, `pwr:reset:ip:${ip}`, 30, 900)
      if (!ipRate.ok) {
        return json(c, 429, { error: "Too many attempts. Try again later.", retry_after: ipRate.retryAfterSeconds })
      }

      const tokenHash = hashToken(tokenRaw)
      const row = await db.one(
        from("password_resets").where(q => q("token_hash").equals(tokenHash)).select(
          "id", "user_id", "expires_at", "used_at",
        ),
      ) as { id: number; user_id: number; expires_at: string; used_at: string | null } | null

      if (!row) return json(c, 400, { error: "Invalid or expired reset link" })
      if (row.used_at) return json(c, 400, { error: "This reset link has already been used" })
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json(c, 400, { error: "This reset link has expired" })
      }

      const hashed = await hash(newPassword)
      await db.execute(
        from("users").where(q => q("id").equals(row.user_id)).update({ password: hashed }),
      )
      await db.execute(
        from("password_resets").where(q => q("id").equals(row.id)).update({ used_at: raw("NOW()") }),
      )

      const revoked = await revokeAllSessions(db, row.user_id)
      logEvent(db, {
        userId: row.user_id,
        event: "password.reset_completed",
        metadata: { revoked_sessions: revoked },
        ip,
        userAgent: ua,
      })

      return json(c, 200, { ok: true })
    })),
  ]
}

export const sweepExpiredPasswordResets = async (db: Connection): Promise<void> => {
  await db.execute(
    from("password_resets").where(q => q("expires_at").lessThan(raw("NOW()"))).del(),
  )
}

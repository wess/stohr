import { randomBytes } from "node:crypto"
import { hash } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import type { Emailer } from "../email/index.ts"
import { passwordResetEmail } from "../email/templates/password.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { revokeAllSessions } from "../security/sessions.ts"
import { requestBaseUrl, teamFor } from "../teams/request.ts"
import { limitBody } from "../util/limitbody/index.ts"
import { isEmail } from "../util/username.ts"
import { hashToken } from "./guard.ts"

export const PWR_PREFIX = "stohr_pwr_"
const TTL_SECONDS = 60 * 60 // 1 hour

const generateResetToken = (): string => `${PWR_PREFIX}${randomBytes(32).toString("base64url")}`

// Mint a one-hour reset token for a user and return the plaintext exactly
// once. Shared by the forgot-password flow, admin resets, and the
// set-your-password link a freshly created team user receives.
export const issuePasswordReset = async (
  db: Connection,
  userId: number,
  ip: string | null,
): Promise<{ token: string; expiresAt: Date }> => {
  const token = generateResetToken()
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000)
  await db.execute(
    from("password_resets").insert({
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      ip,
    }),
  )
  return { token, expiresAt }
}

export const passwordResetUrl = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/$/, "")}/password/reset?token=${encodeURIComponent(token)}`

export const passwordRoutes = (db: Connection, emailer: Emailer, appUrl: string) => {
  const api = pipeline(limitBody(), parseJson)

  return [
    post(
      "/password/forgot",
      api(async c => {
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

        // Only this host's team: an address on another team gets the same
        // silent 200, so one tenant cannot probe another's membership.
        const host = teamFor(c.request)
        const user = (await db.one(
          from("users")
            .where(q => q("email").equals(email))
            .where(q => q("team_id").equals(host.team.id))
            .where(q => q("deleted_at").isNull())
            .select("id", "name", "email"),
        )) as { id: number; name: string; email: string } | null
        // Don't email a reset link to a soft-deleted account — and stay silent
        // either way to avoid leaking which addresses are scheduled for deletion.
        if (!user) return ok

        // The response goes out before the token is written or the email is
        // sent. Awaiting the send here made a real address take a network
        // round-trip longer than an unknown one, which is the leak the
        // generic 200 exists to prevent.
        const baseUrl = requestBaseUrl(c.request, appUrl)
        void (async () => {
          const { token: fullToken } = await issuePasswordReset(db, user.id, ip)
          const resetUrl = passwordResetUrl(baseUrl, fullToken)
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
            metadata: {
              email_ok: sent.ok,
              email_id: sent.ok ? (sent.id ?? null) : null,
              error: sent.ok ? null : sent.error,
            },
            ip,
            userAgent: ua,
          })
        })().catch(err => {
          console.error("[password] reset request failed:", err)
        })

        return ok
      }),
    ),

    post(
      "/password/reset",
      api(async c => {
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)
        const body = c.body as { token?: string; new_password?: string; newPassword?: string }
        const tokenRaw = body.token?.trim() ?? ""
        const newPassword = body.new_password ?? body.newPassword ?? ""

        if (!tokenRaw?.startsWith(PWR_PREFIX)) {
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
        const row = (await db.one({
          text: `SELECT p.id, p.user_id, p.expires_at, p.used_at, u.team_id
                   FROM password_resets p JOIN users u ON u.id = p.user_id
                  WHERE p.token_hash = $1 LIMIT 1`,
          values: [tokenHash],
        })) as { id: number; user_id: number; expires_at: string; used_at: string | null; team_id: number } | null

        // a link minted for one team's host is not a link anywhere else
        if (!row || Number(row.team_id) !== teamFor(c.request).team.id) {
          return json(c, 400, { error: "Invalid or expired reset link" })
        }
        if (row.used_at) return json(c, 400, { error: "This reset link has already been used" })
        if (new Date(row.expires_at).getTime() < Date.now()) {
          return json(c, 400, { error: "This reset link has expired" })
        }

        const hashed = await hash(newPassword)
        await db.execute(
          from("users")
            .where(q => q("id").equals(row.user_id))
            .update({ password: hashed }),
        )
        await db.execute(
          from("password_resets")
            .where(q => q("id").equals(row.id))
            .update({ used_at: raw("NOW()") }),
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
      }),
    ),
  ]
}

export const sweepExpiredPasswordResets = async (db: Connection): Promise<void> => {
  await db.execute(
    from("password_resets")
      .where(q => q("expires_at").lessThan(raw("NOW()")))
      .del(),
  )
}

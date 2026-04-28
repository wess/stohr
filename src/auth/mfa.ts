import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { hash, verify } from "@atlas/auth"
import { requireAuth } from "./guard.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { generateBackupCodes, generateSecret, otpauthUrl, verifyTotp } from "../security/totp.ts"
import { revokeAllSessions } from "../security/sessions.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authJti = (c: any): string | null => (c.assigns.auth as { jti?: string | null }).jti ?? null

const ISSUER = "Stohr"

const hashCodes = async (codes: string[]): Promise<string[]> =>
  Promise.all(codes.map(c => hash(c)))

export const mfaRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/me/mfa", guard(async (c) => {
      const userId = authId(c)
      const row = await db.one(
        from("users").where(q => q("id").equals(userId)).select(
          "totp_enabled", "totp_enabled_at", "totp_backup_codes",
        ),
      ) as { totp_enabled: boolean; totp_enabled_at: string | null; totp_backup_codes: string | null } | null
      const remaining = row?.totp_backup_codes ? (JSON.parse(row.totp_backup_codes) as string[]).length : 0
      return json(c, 200, {
        enabled: !!row?.totp_enabled,
        enabled_at: row?.totp_enabled_at ?? null,
        backup_codes_remaining: remaining,
      })
    })),

    post("/me/mfa/setup", guard(async (c) => {
      const userId = authId(c)
      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("email", "username", "totp_enabled"),
      ) as { email: string; username: string; totp_enabled: boolean } | null
      if (!user) return json(c, 404, { error: "User not found" })
      if (user.totp_enabled) return json(c, 409, { error: "MFA already enabled — disable first to re-enroll" })

      const totpSecret = generateSecret()
      await db.execute(
        from("users").where(q => q("id").equals(userId)).update({ totp_secret: totpSecret }),
      )
      const url = otpauthUrl({
        secret: totpSecret,
        account: user.email || user.username,
        issuer: ISSUER,
      })
      return json(c, 200, { secret: totpSecret, otpauth_url: url })
    })),

    post("/me/mfa/enable", authed(async (c) => {
      const userId = authId(c)
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)
      const body = c.body as { code?: string }
      const code = body.code?.trim() ?? ""
      if (!code) return json(c, 422, { error: "code required" })

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("totp_secret", "totp_enabled"),
      ) as { totp_secret: string | null; totp_enabled: boolean } | null
      if (!user || !user.totp_secret) return json(c, 409, { error: "Run setup first" })
      if (user.totp_enabled) return json(c, 409, { error: "MFA already enabled" })

      if (!verifyTotp(user.totp_secret, code)) {
        return json(c, 401, { error: "Code did not match — try again" })
      }

      const codes = generateBackupCodes(10)
      const hashed = await hashCodes(codes)
      await db.execute(
        from("users").where(q => q("id").equals(userId)).update({
          totp_enabled: true,
          totp_enabled_at: raw("NOW()"),
          totp_backup_codes: JSON.stringify(hashed),
        }),
      )
      const revoked = await revokeAllSessions(db, userId, authJti(c) ?? undefined)
      logEvent(db, { userId, event: "mfa.enabled", metadata: { revoked_other_sessions: revoked }, ip, userAgent: ua })
      return json(c, 200, { ok: true, backup_codes: codes })
    })),

    post("/me/mfa/disable", authed(async (c) => {
      const userId = authId(c)
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)
      const body = c.body as { password?: string; code?: string }
      const password = body.password ?? ""
      const code = body.code?.trim() ?? ""
      if (!password || !code) return json(c, 422, { error: "password and code required" })

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("password", "totp_secret", "totp_enabled"),
      ) as { password: string; totp_secret: string | null; totp_enabled: boolean } | null
      if (!user || !user.totp_enabled || !user.totp_secret) return json(c, 409, { error: "MFA not enabled" })

      const passOk = await verify(password, user.password)
      if (!passOk) return json(c, 401, { error: "Password is incorrect" })
      if (!verifyTotp(user.totp_secret, code)) return json(c, 401, { error: "Code did not match" })

      await db.execute(
        from("users").where(q => q("id").equals(userId)).update({
          totp_enabled: false,
          totp_secret: null,
          totp_backup_codes: null,
          totp_enabled_at: null,
        }),
      )
      const revoked = await revokeAllSessions(db, userId, authJti(c) ?? undefined)
      logEvent(db, { userId, event: "mfa.disabled", metadata: { revoked_other_sessions: revoked }, ip, userAgent: ua })
      return json(c, 200, { ok: true })
    })),

    post("/me/mfa/backup-codes", authed(async (c) => {
      const userId = authId(c)
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)
      const body = c.body as { password?: string }
      const password = body.password ?? ""
      if (!password) return json(c, 422, { error: "password required" })

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("password", "totp_enabled"),
      ) as { password: string; totp_enabled: boolean } | null
      if (!user || !user.totp_enabled) return json(c, 409, { error: "MFA not enabled" })

      const ok = await verify(password, user.password)
      if (!ok) return json(c, 401, { error: "Password is incorrect" })

      const codes = generateBackupCodes(10)
      const hashed = await hashCodes(codes)
      await db.execute(
        from("users").where(q => q("id").equals(userId)).update({
          totp_backup_codes: JSON.stringify(hashed),
        }),
      )
      logEvent(db, { userId, event: "mfa.backup_codes_regenerated", ip, userAgent: ua })
      return json(c, 200, { backup_codes: codes })
    })),
  ]
}

import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "./guard.ts"
import {
  revokeAllSessions,
  revokeSession,
  sweepExpiredSessions,
} from "../security/sessions.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id
const authJti = (c: any): string | null => (c.assigns.auth as { jti?: string | null }).jti ?? null

export const sessionRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }))
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), parseJson)

  // Sweep expired sessions hourly + once at boot.
  setInterval(() => { void sweepExpiredSessions(db) }, 60 * 60 * 1000)
  void sweepExpiredSessions(db)

  return [
    get("/me/sessions", guard(async (c) => {
      const userId = authId(c)
      const currentJti = authJti(c)
      const rows = await db.all(
        from("sessions")
          .where(q => q("user_id").equals(userId))
          .where(q => q("revoked_at").isNull())
          .select("id", "ip", "user_agent", "expires_at", "last_used_at", "created_at")
          .orderBy("last_used_at", "DESC"),
      ) as Array<{ id: string; ip: string | null; user_agent: string | null; expires_at: string; last_used_at: string; created_at: string }>
      return json(c, 200, rows.map(r => ({
        id: r.id,
        ip: r.ip,
        user_agent: r.user_agent,
        expires_at: r.expires_at,
        last_used_at: r.last_used_at,
        created_at: r.created_at,
        current: r.id === currentJti,
      })))
    })),

    del("/me/sessions/:id", guard(async (c) => {
      const userId = authId(c)
      const id = c.params.id
      const ok = await revokeSession(db, id, userId)
      if (!ok) return json(c, 404, { error: "Session not found" })
      logEvent(db, {
        userId,
        event: "session.revoked",
        metadata: { jti: id },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { revoked: id })
    })),

    post("/me/sessions/revoke-others", authed(async (c) => {
      const userId = authId(c)
      const currentJti = authJti(c)
      const count = await revokeAllSessions(db, userId, currentJti ?? undefined)
      logEvent(db, {
        userId,
        event: "session.revoke_others",
        metadata: { count },
        ip: clientIp(c.request),
        userAgent: userAgent(c.request),
      })
      return json(c, 200, { revoked: count })
    })),
  ]
}

import { randomUUID } from "node:crypto"
import { token } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"

const SESSION_TTL_SECONDS = 86400 * 7

export const newJti = (): string => randomUUID()

type AuthPayload = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
}

export const issueSession = async (
  db: Connection,
  user: AuthPayload,
  secret: string,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; jti: string }> => {
  const jti = newJti()
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000)
  const jwt = await token.sign({ ...user, jti }, secret, { expiresIn: SESSION_TTL_SECONDS })
  await db.execute(
    from("sessions").insert({
      id: jti,
      user_id: user.id,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent?.slice(0, 256) ?? null,
      expires_at: expiresAt.toISOString(),
    }),
  )
  return { token: jwt, jti }
}

export const isSessionActive = async (db: Connection, jti: string): Promise<{ active: boolean; userId?: number }> => {
  const row = (await db.one(
    from("sessions")
      .where(q => q("id").equals(jti))
      .select("user_id", "expires_at", "revoked_at"),
  )) as { user_id: number; expires_at: string; revoked_at: string | null } | null
  if (!row) return { active: false }
  if (row.revoked_at) return { active: false, userId: row.user_id }
  if (new Date(row.expires_at).getTime() < Date.now()) return { active: false, userId: row.user_id }
  return { active: true, userId: row.user_id }
}

// `last_used_at` drives the "last active" column on the sessions screen, so
// minute-level precision is plenty — but this used to fire an UPDATE on every
// authenticated request. A single page load in the SPA issues dozens, which
// turned into dozens of writes, matching WAL traffic, and a steady stream of
// dead tuples on a table every request also reads. Throttle per session.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000
// Bound on distinct sessions tracked before we prune. Comfortably above any
// realistic concurrent-session count, and pruning is O(n) over a small map.
const TOUCH_CACHE_MAX = 10_000
const lastTouched = new Map<string, number>()

const pruneTouchCache = (now: number): void => {
  for (const [jti, at] of lastTouched) {
    if (now - at >= TOUCH_INTERVAL_MS) lastTouched.delete(jti)
  }
  // Still oversized after dropping everything stale (i.e. genuinely that many
  // live sessions) — drop the oldest half rather than grow without bound.
  if (lastTouched.size > TOUCH_CACHE_MAX) {
    const sorted = [...lastTouched.entries()].sort((a, b) => a[1] - b[1])
    for (const [jti] of sorted.slice(0, Math.floor(sorted.length / 2))) lastTouched.delete(jti)
  }
}

export const touchSession = (db: Connection, jti: string): void => {
  const now = Date.now()
  const prev = lastTouched.get(jti)
  if (prev !== undefined && now - prev < TOUCH_INTERVAL_MS) return
  lastTouched.set(jti, now)
  if (lastTouched.size > TOUCH_CACHE_MAX) pruneTouchCache(now)
  void db
    .execute(
      from("sessions")
        .where(q => q("id").equals(jti))
        .update({ last_used_at: raw("NOW()") }),
    )
    .catch(() => {
      // Let the next request retry rather than waiting out the throttle.
      lastTouched.delete(jti)
    })
}

export const revokeSession = async (db: Connection, jti: string, userId: number): Promise<boolean> => {
  const rows = (await db.execute(
    from("sessions")
      .where(q => q("id").equals(jti))
      .where(q => q("user_id").equals(userId))
      .where(q => q("revoked_at").isNull())
      .update({ revoked_at: raw("NOW()") })
      .returning("id"),
  )) as Array<{ id: string }>
  return rows.length > 0
}

export const revokeAllSessions = async (db: Connection, userId: number, exceptJti?: string): Promise<number> => {
  let q = from("sessions")
    .where(q => q("user_id").equals(userId))
    .where(q => q("revoked_at").isNull())
  if (exceptJti) {
    q = q.where(qb => qb("id").notEquals(exceptJti))
  }
  const rows = (await db.execute(q.update({ revoked_at: raw("NOW()") }).returning("id"))) as Array<{ id: string }>
  return rows.length
}

export const sweepExpiredSessions = async (db: Connection): Promise<void> => {
  try {
    await db.execute(
      from("sessions")
        .where(q => q("expires_at").lessThan(raw("NOW()")))
        .del(),
    )
  } catch (err) {
    console.error("[sessions] sweep failed:", err)
  }
}

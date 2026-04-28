import { randomUUID } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { token } from "@atlas/auth"

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
  const row = await db.one(
    from("sessions").where(q => q("id").equals(jti)).select("user_id", "expires_at", "revoked_at"),
  ) as { user_id: number; expires_at: string; revoked_at: string | null } | null
  if (!row) return { active: false }
  if (row.revoked_at) return { active: false, userId: row.user_id }
  if (new Date(row.expires_at).getTime() < Date.now()) return { active: false, userId: row.user_id }
  return { active: true, userId: row.user_id }
}

export const touchSession = (db: Connection, jti: string): void => {
  void db.execute(
    from("sessions").where(q => q("id").equals(jti)).update({ last_used_at: raw("NOW()") }),
  ).catch(() => {})
}

export const revokeSession = async (db: Connection, jti: string, userId: number): Promise<boolean> => {
  const rows = await db.execute(
    from("sessions")
      .where(q => q("id").equals(jti))
      .where(q => q("user_id").equals(userId))
      .where(q => q("revoked_at").isNull())
      .update({ revoked_at: raw("NOW()") })
      .returning("id"),
  ) as Array<{ id: string }>
  return rows.length > 0
}

export const revokeAllSessions = async (db: Connection, userId: number, exceptJti?: string): Promise<number> => {
  let q = from("sessions")
    .where(q => q("user_id").equals(userId))
    .where(q => q("revoked_at").isNull())
  if (exceptJti) {
    q = q.where(qb => qb("id").notEquals(exceptJti))
  }
  const rows = await db.execute(
    q.update({ revoked_at: raw("NOW()") }).returning("id"),
  ) as Array<{ id: string }>
  return rows.length
}

export const sweepExpiredSessions = async (db: Connection): Promise<void> => {
  try {
    await db.execute(
      from("sessions").where(q => q("expires_at").lessThan(raw("NOW()"))).del(),
    )
  } catch (err) {
    console.error("[sessions] sweep failed:", err)
  }
}

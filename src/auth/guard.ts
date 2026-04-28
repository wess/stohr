import { createHash } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { token } from "@atlas/auth"
import { assign, halt } from "@atlas/server"
import type { PipeFn } from "@atlas/server"

export const APP_TOKEN_PREFIX = "stohr_pat_"

export const hashToken = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex")

type AppRow = { id: number; user_id: number }
type UserRow = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
}

type RequireAuthOptions = {
  secret: string
  db: Connection
}

export const requireAuth = (opts: RequireAuthOptions): PipeFn =>
  async (conn) => {
    const header = conn.headers.get("authorization")
    if (!header?.startsWith("Bearer ")) {
      return halt(conn, 401, {
        error: "Missing or invalid authorization header. Send 'Authorization: Bearer <token>'.",
      })
    }
    const t = header.slice(7).trim()

    if (t.startsWith(APP_TOKEN_PREFIX)) {
      const tokenHash = hashToken(t)
      const app = await opts.db.one(
        from("apps").where(q => q("token_hash").equals(tokenHash)).select("id", "user_id"),
      ) as AppRow | null
      if (!app) {
        return halt(conn, 401, { error: "Invalid or revoked app token" })
      }
      const user = await opts.db.one(
        from("users")
          .where(q => q("id").equals(app.user_id))
          .select("id", "email", "username", "name", "is_owner"),
      ) as UserRow | null
      if (!user) {
        return halt(conn, 401, { error: "App token references a missing user" })
      }
      // fire-and-forget last_used_at update
      void opts.db.execute(
        from("apps").where(q => q("id").equals(app.id)).update({ last_used_at: raw("NOW()") }),
      ).catch(() => {})
      return assign(conn, {
        auth: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          is_owner: user.is_owner,
          via: "app",
          app_id: app.id,
        },
      })
    }

    try {
      const payload = await token.verify(t, opts.secret)
      return assign(conn, { auth: payload })
    } catch {
      return halt(conn, 401, {
        error: "Invalid or expired token. Re-authenticate to get a fresh token.",
      })
    }
  }

import { createHash } from "node:crypto"
import { token } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { PipeFn } from "@atlas/server"
import { assign, halt } from "@atlas/server"
import { parseScope } from "../oauth/helpers.ts"
import { isSessionActive, touchSession } from "../security/sessions.ts"

export const APP_TOKEN_PREFIX = "stohr_pat_"

export const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex")

type UserRow = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
  deleted_at?: string | null
  suspended_at?: string | null
}

// Accounts scheduled for deletion (deleted_at IS NOT NULL) must reject every
// auth path during the 24h grace window — otherwise an attacker with a
// stolen OAuth access token (or a forgotten PAT) could keep using the account
// up to the hard-delete sweep.
const ACCOUNT_DELETED_ERROR = "Account is scheduled for deletion. Click the cancel link in your email to restore it."
const ACCOUNT_SUSPENDED_ERROR = "Account has been suspended by the owner. Contact the instance owner to restore access."

type RequireAuthOptions = {
  secret: string
  db: Connection
  /** If set, OAuth access tokens must have this scope (or richer) to pass. */
  scope?: string
  /** If true, OAuth access tokens are rejected — for routes that mint further
   * credentials (PATs, MFA setup, OAuth client registration). */
  noOAuth?: boolean
}

export const requireAuth =
  (opts: RequireAuthOptions): PipeFn =>
  async conn => {
    const header = conn.headers.get("authorization")
    if (!header?.startsWith("Bearer ")) {
      return halt(conn, 401, {
        error: "Missing or invalid authorization header. Send 'Authorization: Bearer <token>'.",
      })
    }
    const t = header.slice(7).trim()

    if (t.startsWith(APP_TOKEN_PREFIX)) {
      const tokenHash = hashToken(t)
      // One round-trip instead of two. The join is LEFT so a token whose user
      // row vanished still returns the app row, letting us keep the distinct
      // "references a missing user" error rather than reporting it as an
      // invalid token.
      const row = (await opts.db.one({
        text: `
          SELECT a.id AS app_id,
                 u.id, u.email, u.username, u.name, u.is_owner, u.deleted_at, u.suspended_at
            FROM apps a
            LEFT JOIN users u ON u.id = a.user_id
           WHERE a.token_hash = $1
           LIMIT 1
        `,
        values: [tokenHash],
      })) as (UserRow & { app_id: number; id: number | null }) | null
      if (!row) {
        return halt(conn, 401, { error: "Invalid or revoked app token" })
      }
      if (row.id === null) {
        return halt(conn, 401, { error: "App token references a missing user" })
      }
      if (row.deleted_at) {
        return halt(conn, 403, { error: ACCOUNT_DELETED_ERROR })
      }
      if (row.suspended_at) {
        return halt(conn, 403, { error: ACCOUNT_SUSPENDED_ERROR })
      }
      void opts.db
        .execute(
          from("apps")
            .where(q => q("id").equals(row.app_id))
            .update({ last_used_at: raw("NOW()") }),
        )
        .catch(() => {})
      return assign(conn, {
        auth: {
          id: row.id,
          email: row.email,
          username: row.username,
          name: row.name,
          is_owner: row.is_owner,
          via: "app",
          app_id: row.app_id,
        },
      })
    }

    let payload: any
    try {
      payload = await token.verify(t, opts.secret)
    } catch {
      return halt(conn, 401, {
        error: "Invalid or expired token. Re-authenticate to get a fresh token.",
      })
    }

    // OAuth access tokens carry a client_id claim. They use stateless verification
    // (no session lookup) — revocation is handled via refresh-token rotation.
    if (typeof payload?.client_id === "string") {
      if (opts.noOAuth) {
        return halt(conn, 403, { error: "This endpoint cannot be called with an OAuth access token" })
      }
      if (opts.scope) {
        const granted = parseScope(payload.scope ?? "")
        if (!granted.includes(opts.scope)) {
          return halt(conn, 403, {
            error: `Insufficient scope — '${opts.scope}' is required, token has [${granted.join(", ")}]`,
          })
        }
      }
      // Reject deleted or suspended users even if their access token is
      // still inside its 1h TTL. One PK lookup; cheap relative to the
      // JWT verify above.
      if (typeof payload.id === "number") {
        const u = (await opts.db.one(
          from("users")
            .where(q => q("id").equals(payload.id))
            .select("deleted_at", "suspended_at"),
        )) as { deleted_at: string | null; suspended_at: string | null } | null
        if (!u || u.deleted_at) {
          return halt(conn, 403, { error: ACCOUNT_DELETED_ERROR })
        }
        if (u.suspended_at) {
          return halt(conn, 403, { error: ACCOUNT_SUSPENDED_ERROR })
        }
      }
      return assign(conn, {
        auth: {
          ...payload,
          via: "oauth",
        },
      })
    }

    // Regular user JWT — must match an active session row when a jti is present.
    // The session check and the account-status check are independent, so they
    // go out together rather than one after the other. This is the hottest
    // path in the API; every authenticated request pays for it.
    const jti = typeof payload?.jti === "string" ? payload.jti : null
    const [sess, account] = await Promise.all([
      jti ? isSessionActive(opts.db, jti) : Promise.resolve(null),
      typeof payload?.id === "number"
        ? (opts.db.one(
            from("users")
              .where(q => q("id").equals(payload.id))
              .select("deleted_at", "suspended_at"),
          ) as Promise<{ deleted_at: string | null; suspended_at: string | null } | null>)
        : Promise.resolve(null),
    ])

    if (jti) {
      if (!sess?.active) {
        return halt(conn, 401, { error: "Session revoked. Sign in again." })
      }
      touchSession(opts.db, jti)
    }
    // Defense in depth — sessions are revoked when scheduleDeletion runs, so
    // an active session for a deleted user shouldn't exist, but if it does
    // (race or session-less PAT-style call) we still reject it.
    if (account?.deleted_at) {
      return halt(conn, 403, { error: ACCOUNT_DELETED_ERROR })
    }
    if (account?.suspended_at) {
      return halt(conn, 403, { error: ACCOUNT_SUSPENDED_ERROR })
    }

    return assign(conn, { auth: { ...payload, jti } })
  }

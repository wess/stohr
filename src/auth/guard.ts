import { createHash } from "node:crypto"
import { token } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { Conn, PipeFn } from "@atlas/server"
import { assign, halt } from "@atlas/server"
import { parseScope, type Scope } from "../oauth/helpers.ts"
import { isSessionActive, touchSession } from "../security/sessions.ts"
import { teamFor } from "../teams/request.ts"

export const APP_TOKEN_PREFIX = "stohr_pat_"

export const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex")

type UserRow = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
  team_id: number
  team_admin: boolean
  deleted_at?: string | null
  suspended_at?: string | null
}

type AccountRow = {
  oauth_epoch: number
  team_id: number
  team_admin: boolean
  deleted_at: string | null
  suspended_at: string | null
}

// What every authenticated handler can rely on finding in c.assigns.auth,
// whichever credential type got it there.
export type TeamClaims = { teamId: number; teamAdmin: boolean; isRoot: boolean }

const teamClaims = (row: Pick<UserRow, "team_id" | "team_admin">, isRoot: boolean): TeamClaims => ({
  teamId: Number(row.team_id),
  teamAdmin: row.team_admin,
  isRoot,
})

// Accounts scheduled for deletion (deleted_at IS NOT NULL) must reject every
// auth path during the 24h grace window — otherwise an attacker with a
// stolen OAuth access token (or a forgotten PAT) could keep using the account
// up to the hard-delete sweep.
const ACCOUNT_DELETED_ERROR = "Account is scheduled for deletion. Click the cancel link in your email to restore it."
const ACCOUNT_SUSPENDED_ERROR = "Account has been suspended by the owner. Contact the instance owner to restore access."
const INVALID_TOKEN_ERROR = "Invalid or expired token. Re-authenticate to get a fresh token."

type RequireAuthOptions = {
  secret: string
  db: Connection
  /** OAuth access tokens must carry this scope. When unset the scope is
   * derived from the request: safe methods need `read`, anything under
   * /shares needs `share`, every other method needs `write`. */
  scope?: Scope
  /** If true, OAuth access tokens are rejected — for routes that mint further
   * credentials (PATs, MFA setup, OAuth client registration). */
  noOAuth?: boolean
}

// Share management lives entirely under /shares; reads are safe methods;
// everything else mutates. Routes with a different shape pass `scope`.
export const requiredScope = (conn: Pick<Conn, "method" | "path">): Scope => {
  if (conn.path === "/shares" || conn.path.startsWith("/shares/")) return "share"
  return conn.method === "GET" || conn.method === "HEAD" ? "read" : "write"
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

    // A credential only works on its own team's host. The check is the same
    // generic 401 as a bad token so a credential from another team learns
    // nothing about this one.
    const host = teamFor(conn.request)

    if (t.startsWith(APP_TOKEN_PREFIX)) {
      const tokenHash = hashToken(t)
      // One round-trip instead of two. The join is LEFT so a token whose user
      // row vanished still returns the app row, letting us keep the distinct
      // "references a missing user" error rather than reporting it as an
      // invalid token.
      const row = (await opts.db.one({
        text: `
          SELECT a.id AS app_id,
                 u.id, u.email, u.username, u.name, u.is_owner, u.team_id, u.team_admin,
                 u.deleted_at, u.suspended_at
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
      if (Number(row.team_id) !== host.team.id) {
        return halt(conn, 401, { error: "Invalid or revoked app token" })
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
          ...teamClaims(row, host.isRoot),
          via: "app",
          app_id: row.app_id,
        },
      })
    }

    let payload: any
    try {
      payload = await token.verify(t, opts.secret)
    } catch {
      return halt(conn, 401, { error: INVALID_TOKEN_ERROR })
    }

    // Only two JWT shapes are bearer credentials: session tokens and OAuth
    // access tokens, both with a numeric user id and a string jti. Anything
    // else signed with the same secret — the MFA challenge (`kind: "mfa"`,
    // `uid`), any future one-shot token — must not pass as a login.
    if (
      payload === null ||
      typeof payload !== "object" ||
      payload.kind !== undefined ||
      !Number.isSafeInteger(payload.id) ||
      payload.id <= 0 ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= Date.now() / 1000 ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      payload.iat > Date.now() / 1000 + 60 ||
      typeof payload.jti !== "string"
    ) {
      return halt(conn, 401, { error: INVALID_TOKEN_ERROR })
    }

    // OAuth access tokens carry a client_id claim. They use stateless verification
    // (no session lookup) — revocation is handled via refresh-token rotation.
    if (typeof payload.client_id === "string") {
      if (opts.noOAuth) {
        return halt(conn, 403, { error: "This endpoint cannot be called with an OAuth access token" })
      }
      const granted = parseScope(payload.scope ?? "")
      const required = opts.scope ?? requiredScope(conn)
      if (!granted.includes(required)) {
        return halt(conn, 403, {
          error: `Insufficient scope — '${required}' is required, token has [${granted.join(", ")}]`,
        })
      }
      // Reject deleted or suspended users even if their access token is
      // still inside its 1h TTL. One PK lookup; cheap relative to the
      // JWT verify above.
      const u = (await opts.db.one({
        text: `SELECT u.team_id, u.team_admin, u.deleted_at, u.suspended_at, u.oauth_epoch
                FROM users u JOIN oauth_clients oc ON oc.client_id = $2 AND oc.revoked_at IS NULL
                WHERE u.id = $1`,
        values: [payload.id, payload.client_id],
      })) as AccountRow | null
      if (!u) return halt(conn, 401, { error: INVALID_TOKEN_ERROR })
      if (Number(u.team_id) !== host.team.id) {
        return halt(conn, 401, { error: INVALID_TOKEN_ERROR })
      }
      if ((payload.oauth_epoch ?? 0) !== Number(u.oauth_epoch)) {
        return halt(conn, 401, { error: INVALID_TOKEN_ERROR })
      }
      if (u.deleted_at) {
        return halt(conn, 403, { error: ACCOUNT_DELETED_ERROR })
      }
      if (u.suspended_at) {
        return halt(conn, 403, { error: ACCOUNT_SUSPENDED_ERROR })
      }
      return assign(conn, {
        auth: {
          ...payload,
          ...teamClaims(u, host.isRoot),
          via: "oauth",
        },
      })
    }

    // Regular user JWT — must match an active session row. The session check
    // and the account-status check are independent, so they go out together
    // rather than one after the other. This is the hottest path in the API;
    // every authenticated request pays for it.
    const jti = payload.jti as string
    const [sess, account] = await Promise.all([
      isSessionActive(opts.db, jti),
      opts.db.one(
        from("users")
          .where(q => q("id").equals(payload.id))
          .select("team_id", "team_admin", "deleted_at", "suspended_at", "oauth_epoch"),
      ) as Promise<AccountRow | null>,
    ])

    if (!sess.active || Number(sess.userId) !== payload.id) {
      return halt(conn, 401, { error: "Session revoked. Sign in again." })
    }
    if (account && Number(account.team_id) !== host.team.id) {
      return halt(conn, 401, { error: INVALID_TOKEN_ERROR })
    }
    touchSession(opts.db, jti)
    // Defense in depth — sessions are revoked when scheduleDeletion runs, so
    // an active session for a deleted user shouldn't exist, but if it does
    // (race) we still reject it.
    if (!account || account.deleted_at) {
      return halt(conn, 403, { error: ACCOUNT_DELETED_ERROR })
    }
    if (account.suspended_at) {
      return halt(conn, 403, { error: ACCOUNT_SUSPENDED_ERROR })
    }

    return assign(conn, { auth: { ...payload, ...teamClaims(account, host.isRoot), jti, via: "session" } })
  }

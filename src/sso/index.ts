// SSO relying-party wiring. Mounts @atlas/sso when SSO_ISSUER env is set.
// JIT-creates the local users row on first login; subsequent logins upsert
// by sub (so admins renaming their own Castle account remap cleanly).

import { hash } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { get, json } from "@atlas/server"
import { ensureSsoStateTable, type IdTokenClaims, mountSso, type SsoConfig } from "@atlas/sso"
import { resolvePendingCollabs } from "../auth/index.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import { isValidUsername, normalizeUsername } from "../util/username.ts"

const _SSO_PASSWORD_SENTINEL = "$argon2id$sso$placeholder"

const claimUsername = (claims: IdTokenClaims): string => {
  const raw = claims.preferred_username ?? (claims.email ? claims.email.split("@")[0] : null)
  if (!raw) throw new Error("ID token lacks preferred_username and email")
  const normalized = normalizeUsername(String(raw))
  if (!isValidUsername(normalized)) {
    throw new Error(`Username '${normalized}' from IdP is invalid`)
  }
  return normalized
}

const claimEmail = (claims: IdTokenClaims): string => {
  if (!claims.email) throw new Error("ID token lacks email claim")
  return String(claims.email).toLowerCase()
}

const placeholderHash = async (): Promise<string> => {
  // Stohr's users.password is NOT NULL. Local auth still works for accounts
  // created locally, but SSO-only users get a fixed un-verifiable hash so
  // local login is rejected (verify() returns false on the sentinel) and
  // the only path in is via /auth/sso/login.
  return hash(`disabled-local-password-${Math.random().toString(36)}`)
}

type SyncedUser = { id: number; username: string; name: string; email: string; is_owner: boolean }

const upsertUser = async (db: Connection, claims: IdTokenClaims): Promise<SyncedUser> => {
  const email = claimEmail(claims)
  const username = claimUsername(claims)
  const name = (claims.name as string | undefined)?.trim() || username

  const byEmail = (await db.one(
    from("users")
      .where(q => q("email").equals(email))
      .select("id", "is_owner"),
  )) as { id: number; is_owner: boolean } | null
  const target =
    byEmail ??
    ((await db.one(
      from("users")
        .where(q => q("username").equals(username))
        .select("id", "is_owner"),
    )) as { id: number; is_owner: boolean } | null)

  if (target) {
    await db.execute(
      from("users")
        .where(q => q("id").equals(target.id))
        .update({
          email,
          username,
          name,
        }),
    )
    return { id: target.id, username, name, email, is_owner: target.is_owner }
  }

  const password = await placeholderHash()
  const inserted = (await db.execute(
    from("users").insert({ email, username, name, password, is_owner: false }).returning("id", "is_owner"),
  )) as Array<{ id: number; is_owner: boolean }>
  const row = inserted[0]
  if (!row) throw new Error("user insert failed")
  await resolvePendingCollabs(db, row.id, email)
  return { id: row.id, username, name, email, is_owner: row.is_owner }
}

export const buildStohrSso = (env: {
  db: Connection
  issuerUrl: string
  clientId: string
  clientSecret: string
  secret: string
}) => {
  const cfg: SsoConfig = {
    db: env.db,
    issuerUrl: env.issuerUrl,
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    onAuthenticated: async (db, claims) => {
      const user = await upsertUser(db, claims)
      return { localUserId: user.id, displayName: user.name }
    },
    issueSession: async (conn: Conn, _user, claims) => {
      // Re-lookup so we hand issueSession all the claims it needs.
      const user = await upsertUser(env.db, claims)
      const sess = await issueSession(
        env.db,
        {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          is_owner: user.is_owner,
        },
        env.secret,
        { ip: clientIp(conn.request), userAgent: userAgent(conn.request) },
      )
      logEvent(env.db, {
        userId: user.id,
        event: "sso.login.ok",
        metadata: { iss: claims.iss },
        ip: clientIp(conn.request),
        userAgent: userAgent(conn.request),
      })
      // Stohr's SPA reads the token out of the URL hash on first load —
      // the redirect carries it back. Cookie-based session shipping would
      // need an extra header pass; the URL handoff matches every other
      // path in this app.
      const target = new URL(conn.request.url)
      target.pathname = "/"
      target.hash = `token=${encodeURIComponent(sess.token)}`
      target.search = ""
      const headers = new Headers(conn.respHeaders)
      headers.set("location", target.toString())
      return { ...conn, status: 302, halted: true, respHeaders: headers }
    },
    findLocalUserBySub: async (db, sub) => {
      const id = Number(sub)
      if (!Number.isFinite(id)) return null
      const row = (await db.one(
        from("users")
          .where(q => q("id").equals(id))
          .select("id"),
      )) as { id: number } | null
      return row?.id ?? null
    },
    invalidateSessions: async (db, params) => {
      if (params.localUserId === null || params.localUserId === undefined) return
      const id = typeof params.localUserId === "string" ? Number(params.localUserId) : params.localUserId
      if (!Number.isFinite(id)) return
      await revokeAllSessions(db, id)
    },
  }

  return cfg
}

// Always-mounted discovery for the login page — tells the SPA whether to
// render the "Sign in with Castle" CTA. Lives outside maybeSsoRoutes (which
// only mounts when SSO is configured) so the SPA can always query it.
export const ssoStatusRoutes = (cfg: { ssoIssuer: string; ssoClientId: string; ssoClientSecret: string }) => [
  get("/auth/sso/status", async c =>
    json(c, 200, {
      available: Boolean(cfg.ssoIssuer && cfg.ssoClientId && cfg.ssoClientSecret),
      label: "Castle",
    }),
  ),
]

export const setupStohrSso = async (
  db: Connection,
  env: { issuerUrl: string; clientId: string; clientSecret: string; secret: string },
) => {
  await ensureSsoStateTable(db)
  const cfg = buildStohrSso({ db, ...env })
  return mountSso(cfg)
}

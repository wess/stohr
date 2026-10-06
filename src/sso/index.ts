// SSO relying-party wiring. Mounts @atlas/sso when SSO_ISSUER env is set.
// JIT-creates the local users row on first login; subsequent logins upsert
// by sub (so admins renaming their own Castle account remap cleanly).

import { createHash } from "node:crypto"
import { token } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { get, halt, json } from "@atlas/server"
import { ensureSsoStateTable, type IdTokenClaims, mountSso, type SsoConfig } from "@atlas/sso"
import { upsertFromExternal } from "../auth/external.ts"
import { fetchDiscovery } from "../auth/oidc/discovery.ts"
import { bindLoginState, clearLoginState, loginStateNonce } from "../auth/state.ts"
import { logEvent } from "../security/audit.ts"
import { clientIp, userAgent } from "../security/ratelimit.ts"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import { rootOnlyRoutes } from "../teams/guards.ts"
import { teamFor } from "../teams/request.ts"
import { limitBody } from "../util/limitbody/index.ts"
import { responseJson } from "../util/response/index.ts"

const upsertUser = async (db: Connection, claims: IdTokenClaims) => {
  const now = Math.floor(Date.now() / 1000)
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    typeof claims.iat !== "number" ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    typeof claims.sub !== "string" ||
    !claims.sub
  )
    throw new Error("Invalid ID token claims")
  const result = await upsertFromExternal(
    db,
    {
      provider: "oidc",
      issuer: claims.iss,
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
      email_verified: claims.email_verified === true,
      display_name: typeof claims.name === "string" ? claims.name : null,
      preferred_username: typeof claims.preferred_username === "string" ? claims.preferred_username : null,
    },
    { autoProvision: true },
  )
  if (result.user.deleted_at || result.user.suspended_at) throw new Error("Account unavailable")
  return result.user
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
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (
        (aud.length > 1 && claims.azp !== env.clientId) ||
        (claims.azp !== undefined && claims.azp !== env.clientId)
      ) {
        throw new Error("ID token azp mismatch")
      }
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
      const state = new URL(conn.request.url).searchParams.get("state") ?? ""
      const nonce = loginStateNonce(conn.request, state)
      target.hash = `token=${encodeURIComponent(sess.token)}&sso_nonce=${encodeURIComponent(nonce ?? "")}`
      target.search = ""
      const headers = new Headers(conn.respHeaders)
      headers.set("location", target.toString())
      return clearLoginState({ ...conn, status: 302, halted: true, respHeaders: headers })
    },
    findLocalUserBySub: async (db, sub) => {
      const row = (await db.one(
        from("external_identities")
          .where(q => q("provider").equals("oidc"))
          .where(q => q("issuer").equals(env.issuerUrl))
          .where(q => q("subject").equals(sub))
          .select("user_id"),
      )) as { user_id: number } | null
      return row?.user_id ?? null
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
      // root host only — tenant login pages never show the button
      available: teamFor(c.request).isRoot && Boolean(cfg.ssoIssuer && cfg.ssoClientId && cfg.ssoClientSecret),
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
  return rootOnlyRoutes(
    mountSso(cfg).map(route => ({
      ...route,
      handler: async (c: Conn) => {
        c = await limitBody()(c)
        if (c.halted) return c
        if (c.path === "/auth/sso/callback") {
          const state = new URL(c.request.url).searchParams.get("state") ?? ""
          if (!state || !loginStateNonce(c.request, state))
            return halt(c, 400, { error: "Invalid browser sign-in state" })
        }
        if (c.path === "/auth/sso/backchannel-logout") {
          try {
            const req = c.request.clone()
            const body = req.headers.get("content-type")?.includes("application/json")
              ? ((await req.json()) as { logout_token?: string })
              : Object.fromEntries(new URLSearchParams(await req.text()))
            if (typeof body.logout_token !== "string") return halt(c, 400, { error: "logout_token required" })
            const discovery = await fetchDiscovery(env.issuerUrl)
            const response = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(10_000), redirect: "error" })
            if (!response.ok) return halt(c, 502, { error: "Signing keys unavailable" })
            const jwks = (await responseJson(response)) as { keys: Parameters<typeof token.verifyRs256>[1]["keys"] }
            const claims = await token.verifyRs256(body.logout_token, jwks)
            const now = Math.floor(Date.now() / 1000)
            const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
            const events = claims.events as Record<string, unknown> | undefined
            if (
              claims.iss !== env.issuerUrl ||
              !audiences.includes(env.clientId) ||
              typeof claims.iat !== "number" ||
              !Number.isFinite(claims.iat) ||
              claims.iat > now + 60 ||
              claims.iat < now - 300 ||
              typeof claims.jti !== "string" ||
              !claims.jti ||
              claims.nonce !== undefined ||
              !events?.["http://schemas.openid.net/event/backchannel-logout"]
            ) {
              return halt(c, 400, { error: "Invalid logout token claims" })
            }
            const challenge = `logout:${createHash("sha256").update(`${env.issuerUrl}:${claims.jti}`).digest("hex")}`
            const claimed = (await db.execute({
              text: `INSERT INTO webauthn_challenges (challenge, kind, expires_at)
                    VALUES ($1, 'logout', NOW() + INTERVAL '10 minutes')
                    ON CONFLICT DO NOTHING RETURNING challenge`,
              values: [challenge],
            })) as Array<{ challenge: string }>
            if (claimed.length === 0) return halt(c, 400, { error: "Logout token already used" })
          } catch {
            return halt(c, 400, { error: "Invalid logout token" })
          }
        }
        const out = await route.handler(c)
        if (c.path === "/auth/sso/login" && out.status === 302) {
          const location = out.respHeaders.get("location")
          const state = location ? new URL(location).searchParams.get("state") : null
          if (state) return bindLoginState(out, state)
        }
        return out
      },
    })),
  )
}

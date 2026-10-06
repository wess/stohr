import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { get, halt, json, pipeline, putHeader } from "@atlas/server"
import { logEvent } from "../../security/audit.ts"
import { clientIp, userAgent } from "../../security/ratelimit.ts"
import { issueSession } from "../../security/sessions.ts"
import { rootOnly } from "../../teams/guards.ts"
import { teamFor } from "../../teams/request.ts"
import { responseJson } from "../../util/response/index.ts"
import { randomToken } from "../../util/token.ts"
import { upsertFromExternal } from "../external.ts"
import { fetchDiscovery } from "../oidc/discovery.ts"
import { verifyIdToken } from "../oidc/jwks.ts"
import { safeRedirectPath } from "../redirect.ts"
import { bindLoginState, clearLoginState, loginStateNonce } from "../state.ts"
import { configFor, enabledProviders, type SocialProvider, type SocialProviderConfig } from "./config.ts"
import { exchangeGithubCode, fetchGithubProfile, githubAuthorizeUrl } from "./github.ts"

const STATE_TTL_SEC = 600
const GOOGLE_ISSUER = "https://accounts.google.com"

const b64url = (bytes: Uint8Array): string => {
  const bin = String.fromCharCode(...bytes)
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

const sha256B64u = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return b64url(new Uint8Array(buf))
}

const callbackUrl = (appUrl: string, provider: SocialProvider): string =>
  `${appUrl.replace(/\/$/, "")}/api/auth/${provider}/callback`

const renderError = (c: Conn, msg: string): Conn => {
  const html = `<!doctype html><meta charset=utf-8><title>Sign-in error</title>
<body style="font-family:system-ui;padding:2rem;max-width:42rem;margin:auto">
<h1>Sign-in error</h1>
<p>${msg.replace(/</g, "&lt;")}</p>
<p><a href="/login">Back to sign in</a></p>`
  return putHeader(halt(c, 400, html), "content-type", "text/html; charset=utf-8")
}

const renderRedirect = (c: Conn, toUrl: string, token: string): Conn => {
  // Hand the JWT to the SPA via the URL fragment (#) exactly as the OIDC
  // flow does — the login screen reads location.hash on mount, stores the
  // token, and replaces the URL.
  const state = new URL(c.request.url).searchParams.get("state") ?? ""
  const nonce = loginStateNonce(c.request, state)
  const url = `${toUrl}#token=${encodeURIComponent(token)}&sso_nonce=${encodeURIComponent(nonce ?? "")}`
  return clearLoginState(putHeader(halt(c, 302, ""), "location", url))
}

// Encode the originating provider into the stored state's nonce slot so the
// callback can tell google/github apart without a second column.
const insertState = async (
  db: Connection,
  state: string,
  provider: SocialProvider,
  codeVerifier: string,
  redirect: string,
): Promise<void> => {
  const expiresAt = new Date(Date.now() + STATE_TTL_SEC * 1000)
  await db.execute(
    from("oidc_states").insert({
      state,
      nonce: provider,
      code_verifier: codeVerifier,
      redirect_to: redirect,
      expires_at: expiresAt.toISOString(),
    }),
  )
}

type StateRow = { nonce: string; code_verifier: string; redirect_to: string | null; expires_at: string }

const consumeState = async (db: Connection, state: string): Promise<StateRow | null> => {
  const rows = (await db.execute({
    text: "DELETE FROM oidc_states WHERE state = $1 RETURNING nonce, code_verifier, redirect_to, expires_at",
    values: [state],
  })) as StateRow[]
  const row = rows[0]
  if (!row) return null
  return row
}

const finishLogin = async (
  c: Conn,
  db: Connection,
  secret: string,
  cfg: SocialProviderConfig,
  profile: {
    subject: string
    email: string | null
    email_verified: boolean
    display_name: string | null
    preferred_username: string | null
  },
  redirectTo: string,
): Promise<Conn> => {
  let user: Awaited<ReturnType<typeof upsertFromExternal>>["user"]
  try {
    const result = await upsertFromExternal(
      db,
      {
        provider: cfg.provider,
        subject: profile.subject,
        email: profile.email?.toLowerCase() ?? null,
        email_verified: profile.email_verified,
        display_name: profile.display_name,
        preferred_username: profile.preferred_username,
      },
      { autoProvision: cfg.auto_provision },
    )
    user = result.user
    logEvent(db, {
      userId: user.id,
      event: result.created ? `${cfg.provider}.signup` : `${cfg.provider}.login`,
      ip: clientIp(c.request),
      userAgent: userAgent(c.request),
    })
  } catch (err) {
    return renderError(c, (err as Error).message)
  }

  if (user.deleted_at || user.suspended_at) {
    return renderError(c, "Account is scheduled for deletion. Restore via the cancel link in your email.")
  }

  const sess = await issueSession(
    db,
    { id: user.id, email: user.email, username: user.username, name: user.name, is_owner: user.is_owner },
    secret,
    { ip: clientIp(c.request), userAgent: userAgent(c.request) },
  )
  return renderRedirect(c, redirectTo, sess.token)
}

// Google (OIDC)

const googleStart =
  (db: Connection, appUrl: string) =>
  async (c: Conn): Promise<Conn> => {
    const cfg = configFor("google")
    if (!cfg) return halt(c, 404, { error: "Google sign-in is not enabled on this instance" })

    let disco: Awaited<ReturnType<typeof fetchDiscovery>>
    try {
      disco = await fetchDiscovery(GOOGLE_ISSUER)
    } catch (err) {
      return halt(c, 502, { error: `Google discovery failed: ${(err as Error).message}` })
    }

    const state = randomToken(24)
    const codeVerifier = randomToken(48)
    const codeChallenge = await sha256B64u(codeVerifier)
    const url = new URL(c.request.url)
    const redirect = safeRedirectPath(url.searchParams.get("redirect_to"), appUrl)
    await insertState(db, state, "google", codeVerifier, redirect)

    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.client_id,
      redirect_uri: callbackUrl(appUrl, "google"),
      scope: "openid email profile",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    })
    return bindLoginState(
      putHeader(halt(c, 302, ""), "location", `${disco.authorization_endpoint}?${params.toString()}`),
      state,
    )
  }

const googleCallback =
  (db: Connection, secret: string, appUrl: string) =>
  async (c: Conn): Promise<Conn> => {
    const cfg = configFor("google")
    if (!cfg) return renderError(c, "Google sign-in is not enabled")

    const url = new URL(c.request.url)
    const error = url.searchParams.get("error")
    if (error) return renderError(c, `Identity provider returned: ${error}`)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (!code || !state) return renderError(c, "Missing code or state on callback")
    if (!loginStateNonce(c.request, state)) return renderError(c, "Sign-in browser state did not match")

    const stateRow = await consumeState(db, state)
    if (stateRow?.nonce !== "google") return renderError(c, "Unknown or expired sign-in state")
    if (new Date(stateRow.expires_at).getTime() < Date.now()) {
      return renderError(c, "Sign-in state has expired — start over")
    }

    let disco: Awaited<ReturnType<typeof fetchDiscovery>>
    try {
      disco = await fetchDiscovery(GOOGLE_ISSUER)
    } catch (err) {
      return renderError(c, (err as Error).message)
    }

    const tokenRes = await fetch(disco.token_endpoint, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        redirect_uri: callbackUrl(appUrl, "google"),
        code_verifier: stateRow.code_verifier,
      }),
    })
    if (!tokenRes.ok) {
      await tokenRes.body?.cancel()
      logEvent(db, {
        event: "google.token_exchange_failed",
        metadata: { status: tokenRes.status },
      })
      return renderError(c, `Token exchange failed: ${tokenRes.status}`)
    }
    const tokenBody = (await responseJson(tokenRes)) as { id_token?: string }
    if (!tokenBody.id_token) return renderError(c, "Google did not return an ID token")

    let verified: Awaited<ReturnType<typeof verifyIdToken>>
    try {
      verified = await verifyIdToken(tokenBody.id_token, {
        jwksUri: disco.jwks_uri,
        issuer: disco.issuer,
        clientId: cfg.client_id,
      })
    } catch (err) {
      logEvent(db, { event: "google.id_token_invalid", metadata: { error: (err as Error).message } })
      return renderError(c, `ID token verification failed: ${(err as Error).message}`)
    }

    const claims = verified.claims
    return finishLogin(
      c,
      db,
      secret,
      cfg,
      {
        subject: claims.sub,
        email: (claims.email as string | undefined) ?? null,
        email_verified: claims.email_verified === true,
        display_name: (claims.name as string | undefined) ?? null,
        preferred_username: (claims.preferred_username as string | undefined) ?? null,
      },
      safeRedirectPath(stateRow.redirect_to, appUrl),
    )
  }

// GitHub (plain OAuth2, no PKCE)

const githubStart =
  (db: Connection, appUrl: string) =>
  async (c: Conn): Promise<Conn> => {
    const cfg = configFor("github")
    if (!cfg) return halt(c, 404, { error: "GitHub sign-in is not enabled on this instance" })

    const state = randomToken(24)
    const url = new URL(c.request.url)
    const redirect = safeRedirectPath(url.searchParams.get("redirect_to"), appUrl)
    // GitHub has no PKCE; we still persist a state row to bind the callback.
    await insertState(db, state, "github", "", redirect)

    return bindLoginState(
      putHeader(halt(c, 302, ""), "location", githubAuthorizeUrl(cfg.client_id, callbackUrl(appUrl, "github"), state)),
      state,
    )
  }

const githubCallback =
  (db: Connection, secret: string, appUrl: string) =>
  async (c: Conn): Promise<Conn> => {
    const cfg = configFor("github")
    if (!cfg) return renderError(c, "GitHub sign-in is not enabled")

    const url = new URL(c.request.url)
    const error = url.searchParams.get("error")
    if (error) return renderError(c, `Identity provider returned: ${error}`)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (!code || !state) return renderError(c, "Missing code or state on callback")
    if (!loginStateNonce(c.request, state)) return renderError(c, "Sign-in browser state did not match")

    const stateRow = await consumeState(db, state)
    if (stateRow?.nonce !== "github") return renderError(c, "Unknown or expired sign-in state")
    if (new Date(stateRow.expires_at).getTime() < Date.now()) {
      return renderError(c, "Sign-in state has expired — start over")
    }

    let accessToken: string
    try {
      accessToken = await exchangeGithubCode({
        clientId: cfg.client_id,
        clientSecret: cfg.client_secret,
        code,
        redirectUri: callbackUrl(appUrl, "github"),
      })
    } catch (err) {
      logEvent(db, { event: "github.token_exchange_failed", metadata: { error: (err as Error).message } })
      return renderError(c, (err as Error).message)
    }

    let profile: Awaited<ReturnType<typeof fetchGithubProfile>>
    try {
      profile = await fetchGithubProfile(accessToken)
    } catch (err) {
      return renderError(c, (err as Error).message)
    }

    return finishLogin(c, db, secret, cfg, profile, safeRedirectPath(stateRow.redirect_to, appUrl))
  }

export const socialRoutes = (db: Connection, opts: { secret: string; appUrl: string }) => {
  // external login is a root-team surface; tenant hosts have no such routes
  const pre = pipeline(rootOnly)
  const { secret, appUrl } = opts

  return [
    // Lets the SPA render only the buttons for providers whose env is set.
    get("/auth/social/providers", async c =>
      json(c, 200, {
        providers: teamFor(c.request).isRoot
          ? enabledProviders().map(p => ({ provider: p.provider, label: p.label }))
          : [],
      }),
    ),

    get("/auth/google/start", pre(googleStart(db, appUrl))),
    get("/auth/google/callback", pre(googleCallback(db, secret, appUrl))),
    get("/auth/github/start", pre(githubStart(db, appUrl))),
    get("/auth/github/callback", pre(githubCallback(db, secret, appUrl))),
  ]
}

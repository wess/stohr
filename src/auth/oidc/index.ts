import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { get, halt, json, pipeline, putHeader } from "@atlas/server"
import { logEvent } from "../../security/audit.ts"
import { clientIp, userAgent } from "../../security/ratelimit.ts"
import { issueSession } from "../../security/sessions.ts"
import { randomToken } from "../../util/token.ts"
import { upsertFromExternal } from "../external.ts"
import { isOidcReady, loadOidcConfig } from "./config.ts"
import { fetchDiscovery } from "./discovery.ts"
import { verifyIdToken } from "./jwks.ts"

const STATE_TTL_SEC = 600

const b64url = (bytes: Uint8Array): string => {
  const bin = String.fromCharCode(...bytes)
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

const sha256B64u = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return b64url(new Uint8Array(buf))
}

const callbackUrl = (appUrl: string): string => `${appUrl.replace(/\/$/, "")}/api/auth/oidc/callback`

export const sweepExpiredOidcStates = async (db: Connection): Promise<void> => {
  try {
    await db.execute(
      from("oidc_states")
        .where(q => q("expires_at").lessThan(raw("NOW()")))
        .del(),
    )
  } catch (err) {
    console.error("[oidc] state sweep failed:", err)
  }
}

const renderError = (c: Conn, msg: string): Conn => {
  const html = `<!doctype html><meta charset=utf-8><title>Sign-in error</title>
<body style="font-family:system-ui;padding:2rem;max-width:42rem;margin:auto">
<h1>Sign-in error</h1>
<p>${msg.replace(/</g, "&lt;")}</p>
<p><a href="/login">Back to sign in</a></p>`
  return putHeader(halt(c, 400, html), "content-type", "text/html; charset=utf-8")
}

const renderRedirect = (c: Conn, toUrl: string, token: string): Conn => {
  // Hand the JWT to the SPA via the URL fragment (#) so it never lands in
  // the API logs or a redirect-chain Referer. The login screen reads
  // location.hash on mount, stores the token in localStorage, and replaces
  // the URL.
  const url = `${toUrl}#token=${encodeURIComponent(token)}`
  return putHeader(halt(c, 302, ""), "location", url)
}

export const oidcRoutes = (db: Connection, secret: string, appUrl: string) => {
  const pre = pipeline()

  return [
    // Lightweight discovery for the login page — tells the SPA whether to
    // render the SSO button and what to label it.
    get("/auth/oidc/status", async c => {
      const cfg = await loadOidcConfig(db)
      return json(c, 200, {
        available: isOidcReady(cfg),
        label: cfg.button_label,
      })
    }),

    get(
      "/auth/oidc/start",
      pre(async c => {
        const cfg = await loadOidcConfig(db)
        if (!isOidcReady(cfg)) {
          return halt(c, 503, { error: "OIDC is not configured on this instance" })
        }

        let disco
        try {
          disco = await fetchDiscovery(cfg.issuer_url!)
        } catch (err) {
          return halt(c, 502, { error: `OIDC discovery failed: ${(err as Error).message}` })
        }

        const state = randomToken(24)
        const nonce = randomToken(24)
        const codeVerifier = randomToken(48)
        const codeChallenge = await sha256B64u(codeVerifier)

        // Optional ?redirect_to=<path> — clamp to relative paths only so we
        // can't be turned into an open redirector by a phishing email.
        const url = new URL(c.request.url)
        const requested = url.searchParams.get("redirect_to")
        const redirect = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/"

        const expiresAt = new Date(Date.now() + STATE_TTL_SEC * 1000)
        await db.execute(
          from("oidc_states").insert({
            state,
            nonce,
            code_verifier: codeVerifier,
            redirect_to: redirect,
            expires_at: expiresAt.toISOString(),
          }),
        )

        const params = new URLSearchParams({
          response_type: "code",
          client_id: cfg.client_id!,
          redirect_uri: callbackUrl(appUrl),
          scope: cfg.scopes,
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        })
        return putHeader(halt(c, 302, ""), "location", `${disco.authorization_endpoint}?${params.toString()}`)
      }),
    ),

    get(
      "/auth/oidc/callback",
      pre(async c => {
        const url = new URL(c.request.url)
        const error = url.searchParams.get("error")
        if (error) {
          const desc = url.searchParams.get("error_description") ?? ""
          logEvent(db, { event: "oidc.idp_error", metadata: { error, desc } })
          return renderError(c, `Identity provider returned: ${error}${desc ? ` — ${desc}` : ""}`)
        }
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        if (!code || !state) return renderError(c, "Missing code or state on callback")

        const stateRow = (await db.one(
          from("oidc_states")
            .where(q => q("state").equals(state))
            .select("nonce", "code_verifier", "redirect_to", "expires_at"),
        )) as { nonce: string; code_verifier: string; redirect_to: string | null; expires_at: string } | null
        if (!stateRow) return renderError(c, "Unknown or expired sign-in state")
        // One-shot: delete the state row whether the exchange succeeds or fails
        // so the code can't be replayed.
        await db.execute(
          from("oidc_states")
            .where(q => q("state").equals(state))
            .del(),
        )
        if (new Date(stateRow.expires_at).getTime() < Date.now()) {
          return renderError(c, "Sign-in state has expired — start over")
        }

        const cfg = await loadOidcConfig(db)
        if (!isOidcReady(cfg)) return renderError(c, "OIDC is not configured")

        let disco
        try {
          disco = await fetchDiscovery(cfg.issuer_url!)
        } catch (err) {
          return renderError(c, (err as Error).message)
        }

        const tokenRes = await fetch(disco.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: cfg.client_id!,
            client_secret: cfg.client_secret!,
            redirect_uri: callbackUrl(appUrl),
            code_verifier: stateRow.code_verifier,
          }),
        })
        if (!tokenRes.ok) {
          const body = await tokenRes.text().catch(() => "")
          logEvent(db, {
            event: "oidc.token_exchange_failed",
            metadata: { status: tokenRes.status, body: body.slice(0, 500) },
          })
          return renderError(c, `Token exchange failed: ${tokenRes.status}`)
        }
        const tokenBody = (await tokenRes.json()) as { id_token?: string; access_token?: string }
        if (!tokenBody.id_token) return renderError(c, "Identity provider did not return an ID token")

        let verified
        try {
          verified = await verifyIdToken(tokenBody.id_token, {
            jwksUri: disco.jwks_uri,
            issuer: disco.issuer,
            clientId: cfg.client_id!,
            nonce: stateRow.nonce,
          })
        } catch (err) {
          logEvent(db, { event: "oidc.id_token_invalid", metadata: { error: (err as Error).message } })
          return renderError(c, `ID token verification failed: ${(err as Error).message}`)
        }

        const claims = verified.claims
        const emailClaim = claims[cfg.email_claim] as string | undefined
        const nameClaim = claims[cfg.name_claim] as string | undefined
        const usernameClaim = claims[cfg.username_claim] as string | undefined

        let user
        try {
          const result = await upsertFromExternal(
            db,
            {
              provider: "oidc",
              subject: claims.sub,
              email: emailClaim?.toLowerCase() ?? null,
              display_name: nameClaim ?? null,
              preferred_username: usernameClaim ?? null,
            },
            { autoProvision: cfg.auto_provision },
          )
          user = result.user
          logEvent(db, {
            userId: user.id,
            event: result.created ? "oidc.signup" : "oidc.login",
            ip: clientIp(c.request),
            userAgent: userAgent(c.request),
          })
        } catch (err) {
          return renderError(c, (err as Error).message)
        }

        if (user.deleted_at) {
          return renderError(c, "Account is scheduled for deletion. Restore via the cancel link in your email.")
        }

        const sess = await issueSession(
          db,
          {
            id: user.id,
            email: user.email,
            username: user.username,
            name: user.name,
            is_owner: user.is_owner,
          },
          secret,
          { ip: clientIp(c.request), userAgent: userAgent(c.request) },
        )

        return renderRedirect(c, stateRow.redirect_to ?? "/", sess.token)
      }),
    ),
  ]
}

import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, patch, pipeline, post } from "@atlas/server"
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { issueSession, revokeAllSessions } from "../security/sessions.ts"
import { requestBaseUrl, teamFor } from "../teams/request.ts"
import { parseJson } from "../util/json/index.ts"
import { requireAuth } from "./guard.ts"

// rpId is ROOT_DOMAIN when host routing is on: it is a registrable suffix of
// every team host, so one passkey ceremony works on any subdomain. The
// origin is checked against the host the request resolved to, which
// withTeams already limited to the root domain and live team subdomains.
export type RpConfig = { rpId: string; rpName: string; rpOrigin: string; rootDomain?: string }

const expectedOrigin = (req: Request, rp: RpConfig): string => requestBaseUrl(req, rp.rpOrigin)

// the configured rpId wins on the hosts it covers (app.stohr.io keeps the
// passkeys already registered there); team hosts fall back to ROOT_DOMAIN
export const rpIdFor = (req: Request, rp: RpConfig): string => {
  const team = teamFor(req).team
  if (
    team.custom_domain &&
    team.domain_verified_at &&
    new URL(expectedOrigin(req, rp)).hostname === team.custom_domain
  ) {
    return team.custom_domain
  }
  if (!rp.rootDomain || rp.rootDomain === rp.rpId) return rp.rpId
  const host = new URL(expectedOrigin(req, rp)).hostname
  const under = (d: string) => host === d || host.endsWith(`.${d}`)
  if (under(rp.rpId)) return rp.rpId
  return under(rp.rootDomain) ? rp.rootDomain : rp.rpId
}

type CredentialRow = {
  id: number
  user_id: number
  credential_id: string // base64url
  public_key: string // base64url-encoded COSE key
  counter: number | string
  transports: string // JSON array
  name: string | null
  last_used_at: string | null
  created_at: string
}

const CHALLENGE_TTL_SECONDS = 5 * 60

const b64ToBytes = (s: string) => new Uint8Array(Buffer.from(s, "base64url")).slice()
const bytesToB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url")
const userIdToHandle = (userId: number) => new Uint8Array(Buffer.from(`stohr-user-${userId}`)).slice()

const parseTransports = (raw: string): AuthenticatorTransportFuture[] => {
  try {
    const v = JSON.parse(raw || "[]")
    return Array.isArray(v) ? (v as AuthenticatorTransportFuture[]) : []
  } catch {
    return []
  }
}

const insertChallenge = async (
  db: Connection,
  challenge: string,
  userId: number | null,
  kind: "register" | "authenticate",
) => {
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000)
  await db.execute(
    from("webauthn_challenges").insert({
      challenge,
      user_id: userId,
      kind,
      expires_at: expiresAt,
    }),
  )
}

const consumeChallenge = async (
  db: Connection,
  challenge: string,
  kind: "register" | "authenticate",
): Promise<{ user_id: number | null } | null> => {
  const rows = (await db.execute({
    text: `DELETE FROM webauthn_challenges
            WHERE challenge = $1 AND kind = $2 AND expires_at >= NOW()
            RETURNING user_id`,
    values: [challenge, kind],
  })) as Array<{ user_id: number | null }>
  const row = rows[0]
  if (!row) return null
  return { user_id: row.user_id }
}

const serializeCredential = (row: CredentialRow) => ({
  id: row.id,
  name: row.name,
  transports: parseTransports(row.transports),
  last_used_at: row.last_used_at,
  created_at: row.created_at,
})

const extractChallengeFromClientData = (clientDataJSON: string | undefined): string | null => {
  if (!clientDataJSON) return null
  try {
    const decoded = Buffer.from(clientDataJSON, "base64url").toString("utf-8")
    const parsed = JSON.parse(decoded) as { challenge?: string }
    return typeof parsed.challenge === "string" ? parsed.challenge : null
  } catch {
    return null
  }
}

export const passkeyRoutes = (db: Connection, secret: string, rp: RpConfig) => {
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }))
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), parseJson)
  const open = pipeline(parseJson)

  return [
    /* List a user's passkeys */
    get(
      "/me/passkeys",
      guard(async c => {
        const userId = (c.assigns.auth as { id: number }).id
        const rows = (await db.all(
          from("webauthn_credentials")
            .where(q => q("user_id").equals(userId))
            .orderBy("created_at", "DESC"),
        )) as CredentialRow[]
        return json(c, 200, rows.map(serializeCredential))
      }),
    ),

    /* Begin registration — returns options for navigator.credentials.create() */
    post(
      "/me/passkeys/register/start",
      guard(async c => {
        const auth = c.assigns.auth as { id: number; email: string; username: string; name: string }

        const existing = (await db.all(
          from("webauthn_credentials")
            .where(q => q("user_id").equals(auth.id))
            .select("credential_id", "transports"),
        )) as Array<{ credential_id: string; transports: string }>

        const options = await generateRegistrationOptions({
          rpName: rp.rpName,
          rpID: rpIdFor(c.request, rp),
          userID: userIdToHandle(auth.id),
          userName: auth.email || auth.username,
          userDisplayName: auth.name || auth.username,
          attestationType: "none",
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
          excludeCredentials: existing.map(e => ({
            id: e.credential_id,
            transports: parseTransports(e.transports),
          })),
        })

        await insertChallenge(db, options.challenge, auth.id, "register")
        return json(c, 200, options)
      }),
    ),

    /* Finish registration — verify attestation, store credential */
    post(
      "/me/passkeys/register/finish",
      authed(async c => {
        const auth = c.assigns.auth as { id: number; jti?: string | null }
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)
        const body = c.body as { name?: string; response?: any }
        const response = body.response
        if (!response || typeof response !== "object") {
          return json(c, 422, { error: "response required" })
        }

        const challenge = extractChallengeFromClientData(response?.response?.clientDataJSON)
        if (!challenge) return json(c, 400, { error: "Missing challenge" })

        const ch = await consumeChallenge(db, challenge, "register")
        if (!ch || ch.user_id !== auth.id) {
          return json(c, 400, { error: "Challenge not found or expired" })
        }

        let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
        try {
          verification = await verifyRegistrationResponse({
            response,
            expectedChallenge: challenge,
            expectedOrigin: expectedOrigin(c.request, rp),
            expectedRPID: rpIdFor(c.request, rp),
            requireUserVerification: true,
          })
        } catch (e) {
          return json(c, 400, { error: e instanceof Error ? e.message : "Verification failed" })
        }

        if (!verification.verified || !verification.registrationInfo) {
          return json(c, 400, { error: "Registration not verified" })
        }

        const info = verification.registrationInfo
        const transports = Array.isArray(response?.response?.transports)
          ? (response.response.transports as AuthenticatorTransportFuture[])
          : []
        const credId = info.credential.id
        const publicKeyB64 = bytesToB64(info.credential.publicKey)
        const counter = info.credential.counter ?? 0
        const friendlyName = body.name?.toString().trim() || null

        const inserted = (await db.execute(
          from("webauthn_credentials")
            .insert({
              user_id: auth.id,
              credential_id: credId,
              public_key: publicKeyB64,
              counter,
              transports: JSON.stringify(transports),
              name: friendlyName,
            })
            .returning(
              "id",
              "user_id",
              "credential_id",
              "public_key",
              "counter",
              "transports",
              "name",
              "last_used_at",
              "created_at",
            ),
        )) as CredentialRow[]

        const revoked = await revokeAllSessions(db, auth.id, auth.jti ?? undefined)
        logEvent(db, {
          userId: auth.id,
          event: "passkey.registered",
          metadata: { credential_id: credId, revoked_other_sessions: revoked },
          ip,
          userAgent: ua,
        })

        return json(c, 201, serializeCredential(inserted[0]!))
      }),
    ),

    /* Rename */
    patch(
      "/me/passkeys/:id",
      authed(async c => {
        const auth = c.assigns.auth as { id: number }
        const id = Number(c.params.id)
        const body = c.body as { name?: string | null }
        if (body.name === undefined) return json(c, 422, { error: "name required" })

        const existing = (await db.one(
          from("webauthn_credentials")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(auth.id))
            .select("id"),
        )) as { id: number } | null
        if (!existing) return json(c, 404, { error: "Passkey not found" })

        const next = (body.name ?? "").toString().trim() || null
        await db.execute(
          from("webauthn_credentials")
            .where(q => q("id").equals(id))
            .update({ name: next }),
        )
        return json(c, 200, { ok: true, name: next })
      }),
    ),

    /* Remove */
    del(
      "/me/passkeys/:id",
      guard(async c => {
        const auth = c.assigns.auth as { id: number; jti?: string | null }
        const id = Number(c.params.id)
        const existing = (await db.one(
          from("webauthn_credentials")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(auth.id))
            .select("id", "credential_id"),
        )) as { id: number; credential_id: string } | null
        if (!existing) return json(c, 404, { error: "Passkey not found" })

        await db.execute(
          from("webauthn_credentials")
            .where(q => q("id").equals(id))
            .del(),
        )
        const revoked = await revokeAllSessions(db, auth.id, auth.jti ?? undefined)
        logEvent(db, {
          userId: auth.id,
          event: "passkey.removed",
          metadata: { credential_id: existing.credential_id, revoked_other_sessions: revoked },
          ip: clientIp(c.request),
          userAgent: userAgent(c.request),
        })

        return json(c, 200, { deleted: id })
      }),
    ),

    /* Discoverable login (passwordless): no email, no password.
     * The browser shows the user a list of passkeys for this RP, they pick
     * one, sign, and the server identifies them from the credential row. */
    post(
      "/login/passkey/discover/start",
      open(async c => {
        const rate = await checkRate(db, `passkey:start:ip:${clientIp(c.request)}`, 30, 900)
        if (!rate.ok) return json(c, 429, { error: "Too many attempts.", retry_after: rate.retryAfterSeconds })
        const options = await generateAuthenticationOptions({
          rpID: rpIdFor(c.request, rp),
          userVerification: "required",
          // No allowCredentials → browser handles credential discovery
        })
        await insertChallenge(db, options.challenge, null, "authenticate")
        return json(c, 200, options)
      }),
    ),

    post(
      "/login/passkey/discover/finish",
      open(async c => {
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)
        const rate = await checkRate(db, `passkey:finish:ip:${ip}`, 30, 900)
        if (!rate.ok) return json(c, 429, { error: "Too many attempts.", retry_after: rate.retryAfterSeconds })
        const body = c.body as { response?: any }
        const response = body.response
        if (!response || typeof response !== "object") {
          return json(c, 422, { error: "response required" })
        }

        const challenge = extractChallengeFromClientData(response?.response?.clientDataJSON)
        if (!challenge) return json(c, 400, { error: "Missing challenge" })

        const ch = await consumeChallenge(db, challenge, "authenticate")
        if (!ch) return json(c, 400, { error: "Challenge not found or expired" })

        const credId = response?.id
        if (typeof credId !== "string") return json(c, 400, { error: "Missing credential id" })

        // the credential has to belong to a user of this host's team; a
        // passkey from another team is unknown here
        const cred = (await db.one({
          text: `SELECT wc.* FROM webauthn_credentials wc JOIN users u ON u.id = wc.user_id
                  WHERE wc.credential_id = $1 AND u.team_id = $2 LIMIT 1`,
          values: [credId, teamFor(c.request).team.id],
        })) as CredentialRow | null
        if (!cred) {
          logEvent(db, { event: "login.passkey_fail", metadata: { reason: "unknown_credential" }, ip, userAgent: ua })
          return json(c, 404, { error: "Unknown passkey" })
        }

        let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
        try {
          verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: challenge,
            expectedOrigin: expectedOrigin(c.request, rp),
            expectedRPID: rpIdFor(c.request, rp),
            credential: {
              id: cred.credential_id,
              publicKey: b64ToBytes(cred.public_key),
              counter: Number(cred.counter),
              transports: parseTransports(cred.transports),
            },
            requireUserVerification: true,
          })
        } catch (e) {
          logEvent(db, {
            userId: cred.user_id,
            event: "login.passkey_fail",
            metadata: { error: e instanceof Error ? e.message : String(e) },
            ip,
            userAgent: ua,
          })
          return json(c, 401, { error: e instanceof Error ? e.message : "Verification failed" })
        }

        if (!verification.verified) {
          logEvent(db, { userId: cred.user_id, event: "login.passkey_fail", ip, userAgent: ua })
          return json(c, 401, { error: "Not verified" })
        }

        await db.execute(
          from("webauthn_credentials")
            .where(q => q("id").equals(cred.id))
            .update({
              counter: verification.authenticationInfo.newCounter,
              last_used_at: raw("NOW()"),
            }),
        )

        const user = (await db.one(
          from("users")
            .where(q => q("id").equals(cred.user_id))
            .select("id", "email", "username", "name", "is_owner", "deleted_at", "suspended_at"),
        )) as {
          id: number
          email: string
          username: string
          name: string
          is_owner: boolean
          deleted_at: string | null
          suspended_at: string | null
        } | null
        if (!user || user.deleted_at || user.suspended_at) return json(c, 401, { error: "Account unavailable" })

        logEvent(db, {
          userId: user.id,
          event: "login.ok",
          metadata: { passkey: true, passwordless: true },
          ip,
          userAgent: ua,
        })
        const sess = await issueSession(db, user, secret, { ip, userAgent: ua })
        return json(c, 200, {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          is_owner: user.is_owner,
          token: sess.token,
        })
      }),
    ),
  ]
}

export const sweepExpiredWebauthnChallenges = async (db: Connection): Promise<void> => {
  await db.execute(
    from("webauthn_challenges")
      .where(q => q("expires_at").lessThan(raw("NOW()")))
      .del(),
  )
}

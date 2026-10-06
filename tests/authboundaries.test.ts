import { beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { hash } from "@atlas/auth"
import { from, raw } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { issuePasswordReset } from "../src/auth/password.ts"
import { resolvePendingCollabs } from "../src/auth/index.ts"
import { upsertFromExternal } from "../src/auth/external.ts"
import { generateSecret, totpAt } from "../src/security/totp.ts"
import { sha256 } from "../src/oauth/helpers.ts"

const app = buildApp(db, TEST_SECRET)
const signup = (username: string, invite?: string, email = `${username}@example.com`) =>
  callJson(app, "/signup", { method: "POST", body: { username, email, password: "password123", invite_token: invite } })
const owner = async () => (await signup("owner")).body as { id: number; token: string }
const invite = async (token: string) =>
  (await callJson(app, "/invites", { method: "POST", token, body: {} })).body.token as string
beforeEach(truncateAll)

const oauth = async () => {
  const user = await owner()
  const client = await callJson(app, "/admin/oauth/clients", {
    method: "POST",
    token: user.token,
    body: { name: "Audit", redirect_uris: ["audit://callback"], allowed_scopes: ["read"], is_public_client: true },
  })
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const consent = await callJson(app, "/oauth/authorize/approve", {
    method: "POST",
    token: user.token,
    body: {
      response_type: "code",
      client_id: client.body.client_id,
      redirect_uri: "audit://callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
    },
  })
  const tokens = await callJson(app, "/oauth/token", {
    method: "POST",
    body: {
      grant_type: "authorization_code",
      client_id: client.body.client_id,
      code: new URL(consent.body.redirect_url).searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: "audit://callback",
    },
  })
  return {
    user,
    clientId: client.body.client_id as string,
    refresh: tokens.body.refresh_token as string,
    access: tokens.body.access_token as string,
  }
}

describe("authentication boundaries", () => {
  test("one account wins first-owner bootstrap", async () => {
    const rows = await Promise.all(["firstowner", "secondowner"].map(n => signup(n)))
    expect(rows.map(r => r.status).sort()).toEqual([201, 403])
    expect(rows.filter(r => r.body.is_owner)).toHaveLength(1)
  })

  test("one unbound invite creates only one account concurrently", async () => {
    const user = await owner(),
      token = await invite(user.token)
    const rows = await Promise.all(["personone", "persontwo"].map(n => signup(n, token)))
    expect(rows.map(r => r.status).sort()).toEqual([201, 403])
  })

  test("verified addresses treat wildcard characters literally when claiming files", async () => {
    const user = await owner()
    const folder = await callJson(app, "/folders", { method: "POST", token: user.token, body: { name: "Private" } })
    const token = await invite(user.token)
    const attacker = await signup("attacker", token, "a_ice@example.com")
    await db.execute(
      from("collaborations").insert({
        resource_type: "folder",
        resource_id: folder.body.id,
        invited_by: user.id,
        email: "alice@example.com",
        role: "viewer",
      }),
    )
    await resolvePendingCollabs(db, attacker.body.id, "a_ice@example.com")
    expect((await callJson(app, `/folders/${folder.body.id}`, { token: attacker.body.token })).status).toBe(404)
    const exact = (await db.one(from("collaborations").select("user_id", "email"))) as { user_id: number | null }
    expect(exact.user_id).toBeNull()
  })

  test("one password-reset wins concurrently and invalidates all other reset links", async () => {
    const user = await owner()
    const a = await issuePasswordReset(db, user.id, null),
      b = await issuePasswordReset(db, user.id, null)
    const rows = await Promise.all(
      ["replacement1", "replacement2"].map(new_password =>
        callJson(app, "/password/reset", { method: "POST", body: { token: a.token, new_password } }),
      ),
    )
    expect(rows.map(r => r.status).sort()).toEqual([200, 400])
    expect(
      (
        await callJson(app, "/password/reset", {
          method: "POST",
          body: { token: b.token, new_password: "oldlinkpassword" },
        })
      ).status,
    ).toBe(400)
    expect((await callJson(app, "/me", { token: user.token })).status).toBe(401)
  })

  test("refresh rotation is single use even when presented concurrently", async () => {
    const { clientId, refresh } = await oauth()
    const rows = await Promise.all(
      [1, 2].map(() =>
        callJson(app, "/oauth/token", {
          method: "POST",
          body: {
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: refresh,
          },
        }),
      ),
    )
    expect(rows.map(r => r.status).sort()).toEqual([200, 400])
    const child = rows.find(r => r.status === 200)!.body.refresh_token
    const row = (await db.one(from("oauth_refresh_tokens").where(q => q("token_hash").equals(sha256(child))))) as {
      revoked_at: string | null
    }
    expect(row.revoked_at).not.toBeNull()
  })

  test("suspended accounts cannot renew OAuth grants", async () => {
    const { user, clientId, refresh } = await oauth()
    await db.execute(
      from("users")
        .where(q => q("id").equals(user.id))
        .update({ suspended_at: raw("NOW()") }),
    )
    expect(
      (
        await callJson(app, "/oauth/token", {
          method: "POST",
          body: { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh },
        })
      ).status,
    ).toBe(400)
  })

  test("one backup code cannot complete two distinct MFA challenges", async () => {
    const user = await owner(),
      code = "abcde-12345"
    await db.execute(
      from("users")
        .where(q => q("id").equals(user.id))
        .update({
          totp_enabled: true,
          totp_secret: generateSecret(),
          totp_backup_codes: JSON.stringify([await hash(code)]),
        }),
    )
    const starts = await Promise.all(
      [1, 2].map(() =>
        callJson(app, "/login", { method: "POST", body: { username: "owner", password: "password123" } }),
      ),
    )
    const rows = await Promise.all(
      starts.map(r =>
        callJson(app, "/login/mfa", { method: "POST", body: { mfa_token: r.body.mfa_token, backup_code: code } }),
      ),
    )
    expect(rows.map(r => r.status).sort()).toEqual([200, 401])
  })

  test("password recovery invalidates every existing API credential immediately", async () => {
    const { user, clientId, refresh, access } = await oauth()
    const pat = await callJson(app, "/me/apps", { method: "POST", token: user.token, body: { name: "old" } })
    const s3 = await callJson(app, "/me/s3-keys", { method: "POST", token: user.token, body: { name: "old" } })
    expect((await callJson(app, "/me", { token: access })).status).toBe(200)
    const reset = await issuePasswordReset(db, user.id, null)
    expect(
      (
        await callJson(app, "/password/reset", {
          method: "POST",
          body: { token: reset.token, new_password: "replacement123" },
        })
      ).status,
    ).toBe(200)
    expect((await callJson(app, "/me", { token: access })).status).toBe(401)
    expect((await callJson(app, "/me", { token: pat.body.token })).status).toBe(401)
    expect(await db.one(from("s3_access_keys").where(q => q("access_key").equals(s3.body.access_key)))).toBeNull()
    expect(
      (
        await callJson(app, "/oauth/token", {
          method: "POST",
          body: { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh },
        })
      ).status,
    ).toBe(400)
    const login = await callJson(app, "/login", {
      method: "POST",
      body: { username: "owner", password: "replacement123" },
    })
    const verifier = randomBytes(32).toString("base64url")
    const consent = await callJson(app, "/oauth/authorize/approve", {
      method: "POST",
      token: login.body.token,
      body: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: "audit://callback",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      },
    })
    const fresh = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: clientId,
        code: new URL(consent.body.redirect_url).searchParams.get("code"),
        code_verifier: verifier,
        redirect_uri: "audit://callback",
      },
    })
    expect(fresh.status).toBe(200)
    expect((await callJson(app, "/me", { token: fresh.body.access_token })).status).toBe(200)
  })

  test("changing a password revokes API credentials and reset links while preserving the current session", async () => {
    const { user, access } = await oauth()
    const reset = await issuePasswordReset(db, user.id, null)
    expect(
      (
        await callJson(app, "/me/password", {
          method: "POST",
          token: user.token,
          body: { current_password: "password123", new_password: "replacement123" },
        })
      ).status,
    ).toBe(200)
    expect((await callJson(app, "/me", { token: user.token })).status).toBe(200)
    expect((await callJson(app, "/me", { token: access })).status).toBe(401)
    expect(
      (
        await callJson(app, "/password/reset", {
          method: "POST",
          body: { token: reset.token, new_password: "oldlinkpassword" },
        })
      ).status,
    ).toBe(400)
  })

  test("revoking an OAuth client immediately rejects its existing access token", async () => {
    const { user, clientId, access } = await oauth()
    const client = (await db.one(
      from("oauth_clients")
        .where(q => q("client_id").equals(clientId))
        .select("id"),
    )) as { id: number }
    expect(
      (await callJson(app, `/admin/oauth/clients/${client.id}`, { method: "DELETE", token: user.token })).status,
    ).toBe(200)
    expect((await callJson(app, "/me", { token: access })).status).toBe(401)
  })

  test("a device grant is redeemed only once concurrently", async () => {
    const { user, clientId } = await oauth()
    const device = await callJson(app, "/oauth/device/authorize", { method: "POST", body: { client_id: clientId } })
    await callJson(app, "/oauth/device/approve", {
      method: "POST",
      token: user.token,
      body: { user_code: device.body.user_code },
    })
    const rows = await Promise.all(
      [1, 2].map(() =>
        callJson(app, "/oauth/token", {
          method: "POST",
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: clientId,
            device_code: device.body.device_code,
          },
        }),
      ),
    )
    expect(rows.map(r => r.status).sort()).toEqual([200, 400])
  })

  test("one TOTP step wins across different concurrent challenges and later steps still work", async () => {
    const user = await owner(),
      secret = generateSecret()
    await db.execute(
      from("users")
        .where(q => q("id").equals(user.id))
        .update({ totp_enabled: true, totp_secret: secret }),
    )
    const starts = await Promise.all(
      [1, 2].map(() =>
        callJson(app, "/login", { method: "POST", body: { username: "owner", password: "password123" } }),
      ),
    )
    const code = totpAt(secret)
    const rows = await Promise.all(
      starts.map(r => callJson(app, "/login/mfa", { method: "POST", body: { mfa_token: r.body.mfa_token, code } })),
    )
    expect(rows.map(r => r.status).sort()).toEqual([200, 401])
    const retry = rows.findIndex(r => r.status === 401)
    const later = totpAt(secret, new Date(Date.now() + 30_000))
    expect(
      (
        await callJson(app, "/login/mfa", {
          method: "POST",
          body: { mfa_token: starts[retry].body.mfa_token, code: later },
        })
      ).status,
    ).toBe(200)
  })

  test("enrolling and disabling MFA cannot replay an accepted authenticator step", async () => {
    const user = await owner()
    const setup = await callJson(app, "/me/mfa/setup", { method: "POST", token: user.token })
    const code = totpAt(setup.body.secret)
    expect((await callJson(app, "/me/mfa/enable", { method: "POST", token: user.token, body: { code } })).status).toBe(
      200,
    )
    expect(
      (
        await callJson(app, "/me/mfa/disable", {
          method: "POST",
          token: user.token,
          body: { password: "password123", code },
        })
      ).status,
    ).toBe(401)
    const next = totpAt(setup.body.secret, new Date(Date.now() + 30_000))
    expect(
      (
        await callJson(app, "/me/mfa/disable", {
          method: "POST",
          token: user.token,
          body: { password: "password123", code: next },
        })
      ).status,
    ).toBe(200)
  })

  test("password recovery invalidates outstanding password-step MFA challenges", async () => {
    const user = await owner(),
      secret = generateSecret(),
      backup = "abcde-12345"
    await db.execute(
      from("users")
        .where(q => q("id").equals(user.id))
        .update({ totp_enabled: true, totp_secret: secret, totp_backup_codes: JSON.stringify([await hash(backup)]) }),
    )
    const starts = await Promise.all(
      [1, 2].map(() =>
        callJson(app, "/login", { method: "POST", body: { username: "owner", password: "password123" } }),
      ),
    )
    const reset = await issuePasswordReset(db, user.id, null)
    expect(
      (
        await callJson(app, "/password/reset", {
          method: "POST",
          body: { token: reset.token, new_password: "replacement123" },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await callJson(app, "/login/mfa", {
          method: "POST",
          body: { mfa_token: starts[0].body.mfa_token, code: totpAt(secret) },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await callJson(app, "/login/mfa", {
          method: "POST",
          body: { mfa_token: starts[1].body.mfa_token, backup_code: backup },
        })
      ).status,
    ).toBe(401)
    const account = (await db.one(
      from("users")
        .where(q => q("id").equals(user.id))
        .select("totp_last_step", "totp_backup_codes"),
    )) as { totp_last_step: number | null; totp_backup_codes: string }
    expect(account.totp_last_step).toBeNull()
    expect(JSON.parse(account.totp_backup_codes)).toHaveLength(1)
  })

  test("a password login that verified an old snapshot cannot issue a session after reset", async () => {
    const user = await owner(),
      reset = await issuePasswordReset(db, user.id, null)
    let read!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => {
      read = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let intercepted = false
    const delayed = {
      ...db,
      one: async (query: Parameters<typeof db.one>[0]) => {
        const row = await db.one(query)
        if (!intercepted && row && typeof (row as { password?: unknown }).password === "string") {
          intercepted = true
          read()
          await held
        }
        return row
      },
    } as typeof db
    const pending = callJson(buildApp(delayed, TEST_SECRET), "/login", {
      method: "POST",
      body: { username: "owner", password: "password123" },
    })
    await ready
    expect(
      (
        await callJson(app, "/password/reset", {
          method: "POST",
          body: { token: reset.token, new_password: "replacement123" },
        })
      ).status,
    ).toBe(200)
    release()
    expect((await pending).status).toBe(401)
  })

  test("concurrent MFA completion cannot leave a valid old-password session after recovery", async () => {
    const user = await owner(),
      secret = generateSecret()
    await db.execute(
      from("users")
        .where(q => q("id").equals(user.id))
        .update({ totp_enabled: true, totp_secret: secret }),
    )
    const start = await callJson(app, "/login", {
      method: "POST",
      body: { username: "owner", password: "password123" },
    })
    const reset = await issuePasswordReset(db, user.id, null)
    const [completion, recovered] = await Promise.all([
      callJson(app, "/login/mfa", { method: "POST", body: { mfa_token: start.body.mfa_token, code: totpAt(secret) } }),
      callJson(app, "/password/reset", {
        method: "POST",
        body: { token: reset.token, new_password: "replacement123" },
      }),
    ])
    expect(recovered.status).toBe(200)
    expect([200, 401]).toContain(completion.status)
    if (completion.status === 200)
      expect((await callJson(app, "/me", { token: completion.body.token })).status).toBe(401)
  })

  test("OIDC subject ids are isolated by issuer", async () => {
    const user = await owner()
    const first = await upsertFromExternal(
      db,
      {
        provider: "oidc",
        issuer: "https://old.example",
        subject: "123",
        email: "owner@example.com",
        email_verified: true,
        display_name: null,
      },
      { autoProvision: true },
    )
    const second = await upsertFromExternal(
      db,
      {
        provider: "oidc",
        issuer: "https://new.example",
        subject: "123",
        email: "new@example.com",
        email_verified: true,
        display_name: null,
      },
      { autoProvision: true },
    )
    expect(first.user.id).toBe(user.id)
    expect(second.user.id).not.toBe(user.id)
  })
})

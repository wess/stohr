import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { sha256 } from "../src/oauth/helpers.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const b64url = (buf: Buffer) =>
  buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

const makePkce = () => {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

const seedOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  return { id: res.body.id as number, token: res.body.token as string }
}

const registerClient = async (
  ownerToken: string,
  opts: Partial<{
    name: string
    redirect_uris: string[]
    allowed_scopes: string[]
    is_official: boolean
    is_public_client: boolean
  }> = {},
) => {
  const res = await callJson(app, "/admin/oauth/clients", {
    method: "POST",
    token: ownerToken,
    body: {
      name: opts.name ?? "Butter",
      redirect_uris: opts.redirect_uris ?? ["butter://callback"],
      allowed_scopes: opts.allowed_scopes ?? ["read", "write", "share"],
      is_official: opts.is_official ?? false,
      is_public_client: opts.is_public_client ?? true,
    },
  })
  expect(res.status).toBe(201)
  return res.body as { client_id: string; client_secret?: string }
}

describe("client registration", () => {
  test("only the owner can register clients", async () => {
    await seedOwner()
    // Beta tester invited via direct insert
    const inviteToken = "inv-" + Math.random().toString(36).slice(2)
    await db.execute(
      from("invites").insert({ token: inviteToken }),
    )
    const beta = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Bob", username: "bob", email: "bob@example.com", password: "password123", invite_token: inviteToken },
    })
    const res = await callJson(app, "/admin/oauth/clients", {
      method: "POST",
      token: beta.body.token,
      body: { name: "X", redirect_uris: ["x://y"], allowed_scopes: ["read"] },
    })
    expect(res.status).toBe(403)
  })

  test("rejects bad redirect_uri / unknown scope", async () => {
    const owner = await seedOwner()
    const bad = await callJson(app, "/admin/oauth/clients", {
      method: "POST",
      token: owner.token,
      body: { name: "X", redirect_uris: ["not a url"], allowed_scopes: ["read"] },
    })
    expect(bad.status).toBe(422)

    const badScope = await callJson(app, "/admin/oauth/clients", {
      method: "POST",
      token: owner.token,
      body: { name: "X", redirect_uris: ["x://y"], allowed_scopes: ["wat"] },
    })
    expect(badScope.status).toBe(422)
  })

  test("public client returns no secret; confidential returns one", async () => {
    const owner = await seedOwner()
    const pub = await registerClient(owner.token, { is_public_client: true })
    expect(pub.client_secret).toBeUndefined()

    const conf = await registerClient(owner.token, { name: "Server", is_public_client: false })
    expect(conf.client_secret).toBeTruthy()
    expect(conf.client_secret!.startsWith("cs_")).toBe(true)
  })
})

describe("authorize flow", () => {
  test("info endpoint validates client_id, redirect_uri, response_type, code_challenge", async () => {
    const owner = await seedOwner()
    const client = await registerClient(owner.token)
    const { challenge } = makePkce()

    // Missing PKCE → 400
    const noPkce = await callJson(
      app,
      `/oauth/authorize/info?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("butter://callback")}`,
      { token: owner.token },
    )
    expect(noPkce.status).toBe(400)
    expect(noPkce.body.error).toBe("invalid_request")

    // Wrong redirect_uri → 400
    const badRedir = await callJson(
      app,
      `/oauth/authorize/info?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("evil://wat")}&code_challenge=${challenge}&code_challenge_method=S256`,
      { token: owner.token },
    )
    expect(badRedir.status).toBe(400)

    // Valid → 200, returns client + scopes
    const ok = await callJson(
      app,
      `/oauth/authorize/info?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("butter://callback")}&code_challenge=${challenge}&code_challenge_method=S256&scope=read+write`,
      { token: owner.token },
    )
    expect(ok.status).toBe(200)
    expect(ok.body.client.client_id).toBe(client.client_id)
    expect(ok.body.scopes).toEqual(["read", "write"])
  })

  test("approve creates a single-use auth code with the right TTL window", async () => {
    const owner = await seedOwner()
    const client = await registerClient(owner.token)
    const { challenge } = makePkce()

    const approve = await callJson(app, "/oauth/authorize/approve", {
      method: "POST",
      token: owner.token,
      body: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "butter://callback",
        scope: "read write",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc123",
      },
    })
    expect(approve.status).toBe(200)
    expect(approve.body.redirect_url).toMatch(/^butter:\/\/callback\?/)
    const url = new URL(approve.body.redirect_url)
    const code = url.searchParams.get("code")!
    expect(code).toBeTruthy()
    expect(url.searchParams.get("state")).toBe("abc123")

    const row = await db.one(
      from("oauth_authorization_codes").where(q => q("code").equals(code)),
    ) as { used_at: string | null; expires_at: string } | null
    expect(row?.used_at).toBeNull()
    // Expires within ~60s of now.
    const ttlMs = new Date(row!.expires_at).getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(65_000)
  })

  test("deny returns access_denied error redirect, no code stored", async () => {
    const owner = await seedOwner()
    const client = await registerClient(owner.token)
    const { challenge } = makePkce()

    const deny = await callJson(app, "/oauth/authorize/deny", {
      method: "POST",
      token: owner.token,
      body: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "butter://callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "x",
      },
    })
    expect(deny.status).toBe(200)
    expect(deny.body.redirect_url).toMatch(/error=access_denied/)
  })
})

describe("token endpoint", () => {
  const goodFlow = async () => {
    const owner = await seedOwner()
    const client = await registerClient(owner.token)
    const pkce = makePkce()
    const approve = await callJson(app, "/oauth/authorize/approve", {
      method: "POST",
      token: owner.token,
      body: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "butter://callback",
        scope: "read write",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
    })
    const code = new URL(approve.body.redirect_url).searchParams.get("code")!
    return { owner, client, code, pkce }
  }

  test("authorization_code grant exchanges code for access + refresh", async () => {
    const { client, code, pkce } = await goodFlow()
    const res = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: "butter://callback",
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.token_type).toBe("Bearer")
    expect(res.body.access_token).toBeTruthy()
    expect(res.body.refresh_token).toMatch(/^oat_/)
    expect(res.body.scope).toBe("read write")
  })

  test("PKCE verifier mismatch is rejected", async () => {
    const { client, code } = await goodFlow()
    const res = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: "the-wrong-verifier-which-is-long-enough-to-pass-length",
        redirect_uri: "butter://callback",
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_grant")
  })

  test("redirect_uri must match the one used in /authorize", async () => {
    const { client, code, pkce } = await goodFlow()
    const res = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: "butter://other",
      },
    })
    expect(res.status).toBe(400)
  })

  test("auth code is single-use", async () => {
    const { client, code, pkce } = await goodFlow()
    const first = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: "butter://callback",
      },
    })
    expect(first.status).toBe(200)

    const replay = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: "butter://callback",
      },
    })
    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe("invalid_grant")
  })
})

describe("refresh rotation + reuse detection", () => {
  test("refresh issues new pair and revokes the old one; replay revokes the family", async () => {
    const owner = await seedOwner()
    const client = await registerClient(owner.token)
    const pkce = makePkce()
    const approve = await callJson(app, "/oauth/authorize/approve", {
      method: "POST",
      token: owner.token,
      body: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "butter://callback",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
    })
    const code = new URL(approve.body.redirect_url).searchParams.get("code")!
    const t = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: "butter://callback",
      },
    })
    const r1 = t.body.refresh_token as string

    const t2 = await callJson(app, "/oauth/token", {
      method: "POST",
      body: { grant_type: "refresh_token", client_id: client.client_id, refresh_token: r1 },
    })
    expect(t2.status).toBe(200)
    const r2 = t2.body.refresh_token as string
    expect(r2).not.toBe(r1)

    const oldRow = await db.one(
      from("oauth_refresh_tokens").where(q => q("token_hash").equals(sha256(r1))),
    ) as { revoked_at: string | null } | null
    expect(oldRow?.revoked_at).toBeTruthy()

    // Replay r1 (the old, revoked refresh token) → reuse detected, family burned.
    const replay = await callJson(app, "/oauth/token", {
      method: "POST",
      body: { grant_type: "refresh_token", client_id: client.client_id, refresh_token: r1 },
    })
    expect(replay.status).toBe(400)

    // r2 should now also be revoked (entire family killed).
    const r2Row = await db.one(
      from("oauth_refresh_tokens").where(q => q("token_hash").equals(sha256(r2))),
    ) as { revoked_at: string | null } | null
    expect(r2Row?.revoked_at).toBeTruthy()
  })
})

describe("OAuth access token vs guards", () => {
  const issueAccessToken = async (scope = "read write share") => {
    const owner = await seedOwner()
    const client = await registerClient(owner.token, { allowed_scopes: scope.split(" ") })
    const pkce = makePkce()
    const approve = await callJson(app, "/oauth/authorize/approve", {
      method: "POST",
      token: owner.token,
      body: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "butter://callback",
        scope,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      },
    })
    const code = new URL(approve.body.redirect_url).searchParams.get("code")!
    const t = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: "butter://callback",
      },
    })
    return { ownerJwt: owner.token, accessToken: t.body.access_token as string }
  }

  test("OAuth access token can hit /me", async () => {
    const { accessToken } = await issueAccessToken()
    const me = await callJson(app, "/me", { token: accessToken })
    expect(me.status).toBe(200)
    expect(me.body.username).toBe("owner")
  })

  test("OAuth access token is rejected by credential-mint routes", async () => {
    const { accessToken } = await issueAccessToken()
    const mintPat = await callJson(app, "/me/apps", {
      method: "POST",
      token: accessToken,
      body: { name: "evil-pat" },
    })
    expect(mintPat.status).toBe(403)
    expect(mintPat.body.error).toMatch(/OAuth/i)

    const mintS3 = await callJson(app, "/me/s3-keys", {
      method: "POST",
      token: accessToken,
      body: { name: "evil-key" },
    })
    expect(mintS3.status).toBe(403)
  })

  test("OAuth access token cannot register OAuth clients (admin escalation blocked)", async () => {
    const { accessToken } = await issueAccessToken()
    const res = await callJson(app, "/admin/oauth/clients", {
      method: "POST",
      token: accessToken,
      body: { name: "X", redirect_uris: ["x://y"], allowed_scopes: ["read"] },
    })
    expect(res.status).toBe(403)
  })
})

describe("discovery", () => {
  test("/.well-known/oauth-authorization-server is correct", async () => {
    const res = await callJson(app, "/.well-known/oauth-authorization-server")
    expect(res.status).toBe(200)
    expect(res.body.scopes_supported).toEqual(["read", "write", "share"])
    expect(res.body.code_challenge_methods_supported).toEqual(["S256"])
    expect(res.body.grant_types_supported).toEqual(["authorization_code", "refresh_token"])
    expect(res.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/)
    expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/)
  })
})

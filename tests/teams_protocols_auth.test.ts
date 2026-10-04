import { createHash, randomBytes } from "node:crypto"
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { computeSignature, sha256OfBytes } from "../src/s3/sigv4.ts"
import type { App } from "./helpers/http.ts"
import { callJson, callRaw, makeRequest } from "./helpers/http.ts"
import { buildProtocolApp } from "./helpers/protocolapp.ts"
import { hostOf, ROOT, type Session, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

// Every credential type the protocol surfaces accept is pinned to its team's
// host: a tenant's PAT, S3 key, OAuth grant or session is refused on root and
// on every other team's host with the same answer an unknown credential gets.

let app: App

beforeAll(() => {
  app = buildProtocolApp(db, TEST_SECRET)
})
beforeEach(async () => {
  await truncateAll()
})

const settings = (owner: Session, body: Record<string, boolean>) =>
  callJson(app, "/admin/settings", { method: "PATCH", host: ROOT, token: owner.token, body })

const mintPat = async (host: string, token: string): Promise<string> => {
  const res = await callJson(app, "/me/apps", { method: "POST", host, token, body: { name: "cli" } })
  expect(res.status).toBe(201)
  return res.body.token as string
}

const mintS3Key = async (host: string, token: string) => {
  const res = await callJson(app, "/me/s3-keys", { method: "POST", host, token, body: { name: "k" } })
  expect(res.status).toBe(201)
  return { accessKey: res.body.access_key as string, secretKey: res.body.secret_key as string }
}

const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")

// signs the way an sdk would, without the host header, so the very same
// request can be replayed against another host
const s3 = async (
  host: string,
  creds: { accessKey: string; secretKey: string },
  method: string,
  path: string,
  body?: string,
) => {
  const bodyBytes = body === undefined ? null : new TextEncoder().encode(body)
  const date = amzDate(Date.now())
  const credDate = date.slice(0, 8)
  const payloadHash = bodyBytes ? sha256OfBytes(bodyBytes) : "UNSIGNED-PAYLOAD"
  const headers: Record<string, string> = { "x-amz-date": date, "x-amz-content-sha256": payloadHash }
  const scope = `${credDate}/us-east-1/s3/aws4_request`
  const signature = computeSignature({
    method,
    path,
    query: "",
    headers,
    payloadHash,
    secretKey: creds.secretKey,
    amzDate: date,
    sig: {
      accessKey: creds.accessKey,
      date: credDate,
      region: "us-east-1",
      service: "s3",
      scope,
      signedHeaders: ["x-amz-content-sha256", "x-amz-date"],
      signature: "",
    },
  })
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=x-amz-content-sha256;x-amz-date, Signature=${signature}`
  if (bodyBytes) headers["content-type"] = "text/plain"
  const res = await app(makeRequest(path, { method, headers, body: bodyBytes, host }))
  return { status: res.status, text: await res.text() }
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
const makePkce = () => {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

const REDIRECT = "stohrshot://oauth/callback"

const registerClient = async (owner: Session): Promise<string> => {
  const res = await callJson(app, "/admin/oauth/clients", {
    method: "POST",
    host: ROOT,
    token: owner.token,
    body: { name: "Shot", redirect_uris: [REDIRECT], allowed_scopes: ["read", "write"], is_public_client: true },
  })
  expect(res.status).toBe(201)
  return res.body.client_id as string
}

// consent on the user's host, returns the code the client would receive
const approve = async (host: string, token: string, clientId: string, challenge: string): Promise<string> => {
  const res = await callJson(app, "/oauth/authorize/approve", {
    method: "POST",
    host,
    token,
    body: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "read write",
      code_challenge: challenge,
      code_challenge_method: "S256",
    },
  })
  expect(res.status).toBe(200)
  return new URL(res.body.redirect_url).searchParams.get("code")!
}

const exchange = (host: string, clientId: string, code: string, verifier: string) =>
  callJson(app, "/oauth/token", {
    method: "POST",
    host,
    body: { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT },
  })

describe("session and personal access tokens", () => {
  test("a tenant jwt and pat are refused on root and on another team's host", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const b = await teamWithAdmin(app, owner, "beta")
    const pat = await mintPat(a.host, a.admin.token)

    for (const token of [a.admin.token, pat]) {
      expect((await callJson(app, "/me", { host: a.host, token })).status).toBe(200)
      expect((await callJson(app, "/me", { host: ROOT, token })).status).toBe(401)
      expect((await callJson(app, "/me", { host: b.host, token })).status).toBe(401)
    }
  })
})

describe("webdav basic auth", () => {
  test("email + pat only mounts on the team host", async () => {
    const owner = await signupOwner(app)
    await settings(owner, { webdav_enabled: true })
    const a = await teamWithAdmin(app, owner, "acme")
    const b = await teamWithAdmin(app, owner, "beta")
    const pat = await mintPat(a.host, a.admin.token)
    const basic = { user: a.created.admin.email, pass: pat }

    const own = await callRaw(app, "/webdav/", { method: "PROPFIND", host: a.host, basic, headers: { depth: "0" } })
    expect(own.status).toBe(207)

    const onRoot = await callRaw(app, "/webdav/", { method: "PROPFIND", host: ROOT, basic, headers: { depth: "0" } })
    expect(onRoot.status).toBe(401)
    expect(onRoot.headers.get("www-authenticate")).toContain("Basic")
    const onBeta = await callRaw(app, "/webdav/", { method: "PROPFIND", host: b.host, basic, headers: { depth: "0" } })
    expect(onBeta.status).toBe(401)

    // same body as a wrong password, so nothing says the account exists
    const wrong = await callRaw(app, "/webdav/", {
      method: "PROPFIND",
      host: ROOT,
      basic: { user: basic.user, pass: "stohr_pat_nope" },
      headers: { depth: "0" },
    })
    expect(wrong.status).toBe(401)
    expect(onRoot.text).toBe(wrong.text)

    // and the owner's own pat is nothing on the tenant host
    const ownerPat = await mintPat(ROOT, owner.token)
    const ownerOnTenant = await callRaw(app, "/webdav/", {
      method: "PROPFIND",
      host: a.host,
      basic: { user: "owner@example.com", pass: ownerPat },
      headers: { depth: "0" },
    })
    expect(ownerOnTenant.status).toBe(401)
  })
})

describe("s3 gateway", () => {
  test("an access key signs requests for its team host only", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const b = await teamWithAdmin(app, owner, "beta")
    const creds = await mintS3Key(a.host, a.admin.token)
    const bucket = a.created.admin.username

    const put = await s3(a.host, creds, "PUT", `/s3/${bucket}/a.txt`, "hello")
    expect(put.status).toBe(200)
    expect((await s3(a.host, creds, "GET", `/s3/${bucket}/a.txt`)).text).toBe("hello")

    const onRoot = await s3(ROOT, creds, "GET", `/s3/${bucket}/a.txt`)
    expect(onRoot.status).toBe(403)
    expect(onRoot.text).toContain("InvalidAccessKeyId")
    const onBeta = await s3(b.host, creds, "GET", `/s3/${bucket}/a.txt`)
    expect(onBeta.status).toBe(403)

    // indistinguishable from a key that was never issued
    const unknown = await s3(ROOT, { accessKey: "AKIANOPE", secretKey: creds.secretKey }, "GET", `/s3/${bucket}/a.txt`)
    expect(unknown.status).toBe(403)
    expect(onRoot.text).toBe(unknown.text)

    // the write never happened on root either
    const rows = await db.all(from("files").where(q => q("user_id").equals(a.created.admin.id)))
    expect(rows).toHaveLength(1)
  })
})

describe("mcp", () => {
  test("the endpoint answers a tenant credential on the tenant host only", async () => {
    const owner = await signupOwner(app)
    await settings(owner, { mcp_enabled: true })
    const a = await teamWithAdmin(app, owner, "acme")
    const pat = await mintPat(a.host, a.admin.token)
    const init = { jsonrpc: "2.0", id: 1, method: "initialize" }

    for (const token of [pat, a.admin.token]) {
      expect((await callJson(app, "/mcp", { method: "POST", host: a.host, token, body: init })).status).toBe(200)
      expect((await callJson(app, "/mcp", { method: "POST", host: ROOT, token, body: init })).status).toBe(401)
    }

    // discovery advertises the host it was asked on
    const disco = await callJson(app, "/mcp", { host: a.host })
    expect(disco.body.endpoint).toBe(`http://${hostOf("acme")}/mcp`)
    expect((await callJson(app, "/mcp", { host: ROOT })).body.endpoint).toBe("http://test.local/mcp")
  })
})

describe("oauth grants", () => {
  test("a code approved on a tenant host is only redeemable there, and the tokens only work there", async () => {
    const owner = await signupOwner(app)
    const clientId = await registerClient(owner)
    const a = await teamWithAdmin(app, owner, "acme")

    // redeemed on root: refused, and single-use means the code is gone
    const first = makePkce()
    const code1 = await approve(a.host, a.admin.token, clientId, first.challenge)
    const onRoot = await exchange(ROOT, clientId, code1, first.verifier)
    expect(onRoot.status).toBe(400)
    expect(onRoot.body.error).toBe("invalid_grant")
    expect((await exchange(a.host, clientId, code1, first.verifier)).status).toBe(400)

    const second = makePkce()
    const code2 = await approve(a.host, a.admin.token, clientId, second.challenge)
    const ok = await exchange(a.host, clientId, code2, second.verifier)
    expect(ok.status).toBe(200)
    const access = ok.body.access_token as string
    const refresh = ok.body.refresh_token as string

    expect((await callJson(app, "/me", { host: a.host, token: access })).status).toBe(200)
    expect((await callJson(app, "/me", { host: ROOT, token: access })).status).toBe(401)
    expect((await callJson(app, "/me", { host: hostOf("beta"), token: access })).status).toBe(404)

    const refreshOnRoot = await callJson(app, "/oauth/token", {
      method: "POST",
      host: ROOT,
      body: { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh },
    })
    expect(refreshOnRoot.status).toBe(400)
    expect(refreshOnRoot.body.error).toBe("invalid_grant")
    // the refused attempt rotated nothing: the token still works at home
    const refreshHome = await callJson(app, "/oauth/token", {
      method: "POST",
      host: a.host,
      body: { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh },
    })
    expect(refreshHome.status).toBe(200)
  })

  test("device flow: the verification url is the team host and the device code redeems there only", async () => {
    const owner = await signupOwner(app)
    const clientId = await registerClient(owner)
    const a = await teamWithAdmin(app, owner, "acme")

    const start = async () => {
      const res = await callJson(app, "/oauth/device/authorize", {
        method: "POST",
        host: a.host,
        body: { client_id: clientId, scope: "read" },
      })
      expect(res.status).toBe(200)
      expect(res.body.verification_uri).toBe(`http://${hostOf("acme")}/pair`)
      const approved = await callJson(app, "/oauth/device/approve", {
        method: "POST",
        host: a.host,
        token: a.admin.token,
        body: { user_code: res.body.user_code },
      })
      expect(approved.status).toBe(200)
      return res.body.device_code as string
    }
    const poll = (host: string, deviceCode: string) =>
      callJson(app, "/oauth/token", {
        method: "POST",
        host,
        body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode },
      })

    const wrongHost = await poll(ROOT, await start())
    expect(wrongHost.status).toBe(400)
    expect(wrongHost.body.error).toBe("invalid_grant")

    const home = await poll(a.host, await start())
    expect(home.status).toBe(200)
    expect((await callJson(app, "/me", { host: a.host, token: home.body.access_token })).status).toBe(200)
    expect((await callJson(app, "/me", { host: ROOT, token: home.body.access_token })).status).toBe(401)
  })
})

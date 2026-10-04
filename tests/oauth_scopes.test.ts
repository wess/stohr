import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson, TEST_APP_URL } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const b64url = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

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
  expect(res.status).toBe(201)
  return { id: res.body.id as number, token: res.body.token as string }
}

// Full PKCE round trip that ends with an access token carrying exactly `scope`.
const issueAccessToken = async (ownerToken: string, scope: string) => {
  const client = await callJson(app, "/admin/oauth/clients", {
    method: "POST",
    token: ownerToken,
    body: { name: "Butter", redirect_uris: ["butter://callback"], allowed_scopes: ["read", "write", "share"] },
  })
  expect(client.status).toBe(201)
  const clientId = client.body.client_id as string
  const pkce = makePkce()
  const approve = await callJson(app, "/oauth/authorize/approve", {
    method: "POST",
    token: ownerToken,
    body: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: "butter://callback",
      scope,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    },
  })
  expect(approve.status).toBe(200)
  const code = new URL(approve.body.redirect_url).searchParams.get("code")!
  const t = await callJson(app, "/oauth/token", {
    method: "POST",
    body: {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pkce.verifier,
      redirect_uri: "butter://callback",
    },
  })
  expect(t.status).toBe(200)
  return { accessToken: t.body.access_token as string, clientId }
}

describe("OAuth scope enforcement", () => {
  test("read-only token can read but not write or share", async () => {
    const owner = await seedOwner()
    const { accessToken } = await issueAccessToken(owner.token, "read")

    const me = await callJson(app, "/me", { token: accessToken })
    expect(me.status).toBe(200)

    const folders = await callJson(app, "/folders", { token: accessToken })
    expect(folders.status).toBe(200)

    const create = await callJson(app, "/folders", { method: "POST", token: accessToken, body: { name: "Docs" } })
    expect(create.status).toBe(403)
    expect(create.body.error).toMatch(/Insufficient scope — 'write'/)

    const shares = await callJson(app, "/shares", { token: accessToken })
    expect(shares.status).toBe(403)
    expect(shares.body.error).toMatch(/'share' is required/)
  })

  test("write token can mutate but share management still needs share", async () => {
    const owner = await seedOwner()
    const { accessToken } = await issueAccessToken(owner.token, "read write")

    const create = await callJson(app, "/folders", { method: "POST", token: accessToken, body: { name: "Docs" } })
    expect(create.status).toBe(201)

    const shares = await callJson(app, "/shares", { token: accessToken })
    expect(shares.status).toBe(403)
  })

  test("share token reaches /shares", async () => {
    const owner = await seedOwner()
    const { accessToken } = await issueAccessToken(owner.token, "read write share")
    const shares = await callJson(app, "/shares", { token: accessToken })
    expect(shares.status).toBe(200)
  })

  test("OAuth tokens cannot change profile identity or approve further grants", async () => {
    const owner = await seedOwner()
    const { accessToken, clientId } = await issueAccessToken(owner.token, "read write share")

    const patchMe = await callJson(app, "/me", { method: "PATCH", token: accessToken, body: { name: "Evil" } })
    expect(patchMe.status).toBe(403)
    expect(patchMe.body.error).toMatch(/OAuth/)

    const { challenge } = makePkce()
    const info = await callJson(
      app,
      `/oauth/authorize/info?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("butter://callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
      { token: accessToken },
    )
    expect(info.status).toBe(403)

    const approve = await callJson(app, "/oauth/authorize/approve", {
      method: "POST",
      token: accessToken,
      body: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: "butter://callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
    })
    expect(approve.status).toBe(403)

    const deviceInfo = await callJson(app, "/oauth/device/info?user_code=ABCD-EFGH", { token: accessToken })
    expect(deviceInfo.status).toBe(403)
    const deviceApprove = await callJson(app, "/oauth/device/approve", {
      method: "POST",
      token: accessToken,
      body: { user_code: "ABCD-EFGH" },
    })
    expect(deviceApprove.status).toBe(403)
  })

  test("MCP gates each tool by scope and hides what the token can't call", async () => {
    const owner = await seedOwner()
    await callJson(app, "/admin/settings", {
      method: "PATCH",
      token: owner.token,
      body: { mcp_enabled: true, mcp_tool_write: true, mcp_tool_share: true },
    })
    const { accessToken } = await issueAccessToken(owner.token, "read")

    const rpc = (method: string, params?: unknown, id = 1) =>
      callJson(app, "/mcp", { method: "POST", token: accessToken, body: { jsonrpc: "2.0", id, method, params } })

    const init = await rpc("initialize")
    expect(init.status).toBe(200)

    const list = await rpc("tools/list", undefined, 2)
    const names = list.body.result.tools.map((t: any) => t.name)
    expect(names).toContain("list_folders")
    expect(names).not.toContain("create_folder")
    expect(names).not.toContain("create_share")

    const call = await rpc("tools/call", { name: "create_folder", arguments: { name: "x" } }, 3)
    expect(call.status).toBe(200)
    expect(call.body.result.isError).toBe(true)
    expect(call.body.result.content[0].text).toMatch(/'write' scope/)

    const ok = await rpc("tools/call", { name: "list_folders", arguments: {} }, 4)
    expect(ok.status).toBe(200)
    expect(ok.body.result.isError).toBeUndefined()
  })

  test("PATs and sessions are not scope-checked", async () => {
    const owner = await seedOwner()
    const pat = await callJson(app, "/me/apps", { method: "POST", token: owner.token, body: { name: "cli" } })
    const create = await callJson(app, "/folders", { method: "POST", token: pat.body.token, body: { name: "Docs" } })
    expect(create.status).toBe(201)
    const shares = await callJson(app, "/shares", { token: pat.body.token })
    expect(shares.status).toBe(200)
  })
})

describe("OAuth client hygiene", () => {
  test("discovery issuer comes from APP_URL, not the Host header", async () => {
    const res = await callJson(app, "/.well-known/oauth-authorization-server", {
      headers: { host: "evil.example" },
    })
    expect(res.status).toBe(200)
    expect(res.body.issuer).toBe(TEST_APP_URL)
    expect(res.body.token_endpoint).toBe(`${TEST_APP_URL}/oauth/token`)
  })

  test("script-bearing redirect_uri schemes are rejected", async () => {
    const owner = await seedOwner()
    for (const uri of ["javascript:alert(1)", "data:text/html,hi", "vbscript:x", "file:///etc/passwd", "https://x/cb#f"]) {
      const res = await callJson(app, "/admin/oauth/clients", {
        method: "POST",
        token: owner.token,
        body: { name: "X", redirect_uris: [uri], allowed_scopes: ["read"] },
      })
      expect(res.status).toBe(422)
    }
    const ok = await callJson(app, "/admin/oauth/clients", {
      method: "POST",
      token: owner.token,
      body: { name: "X", redirect_uris: ["butter://callback", "http://localhost:5173/cb"], allowed_scopes: ["read"] },
    })
    expect(ok.status).toBe(201)
  })
})

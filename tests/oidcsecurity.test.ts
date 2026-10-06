import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { router, get, json } from "@atlas/server"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { clearJwksCache, verifyIdToken } from "../src/auth/oidc/jwks.ts"
import { clearDiscoveryCache, fetchDiscovery } from "../src/auth/oidc/discovery.ts"
import { bindLoginState, loginStateNonce } from "../src/auth/state.ts"
import { upsertFromExternal } from "../src/auth/external.ts"
import { buildStohrSso, setupStohrSso } from "../src/sso/index.ts"

let keys: CryptoKeyPair, server: ReturnType<typeof Bun.serve>, jwksUri: string, publicKey: JsonWebKey
beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
  publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey)
  server = Bun.serve({
    port: 0,
    fetch: req =>
      new URL(req.url).pathname === "/jwks"
        ? Response.json({ keys: [{ ...publicKey, kid: "test", alg: "RS256" }] })
        : Response.json({
            issuer: new URL(req.url).pathname.startsWith("/id/")
              ? `http://localhost:${server.port}/id`
              : "https://different.example",
            authorization_endpoint: "https://different.example/auth",
            token_endpoint: "https://different.example/token",
            jwks_uri: `http://localhost:${server.port}/jwks`,
          }),
  })
  jwksUri = `http://localhost:${server.port}/jwks`
})
afterAll(() => server.stop(true))
beforeEach(async () => {
  clearJwksCache()
  clearDiscoveryCache()
  await truncateAll()
})
const signed = async (patch: Record<string, unknown> = {}, kid = "test") => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url")
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64(JSON.stringify({ alg: "RS256", kid }))}.${b64(
    JSON.stringify({
      iss: "https://id.example",
      sub: "123",
      aud: "stohr",
      exp: now + 60,
      iat: now,
      nonce: "nonce",
      ...patch,
    }),
  )}`
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body))
  return `${body}.${Buffer.from(sig).toString("base64url")}`
}
const check = async (patch: Record<string, unknown> = {}, kid = "test") =>
  verifyIdToken(await signed(patch, kid), { jwksUri, issuer: "https://id.example", clientId: "stohr", nonce: "nonce" })

describe("OIDC verification", () => {
  test("requires expiry and issuance time on signed ID tokens", async () => {
    await expect(check()).resolves.toHaveProperty("claims.sub", "123")
    for (const exp of [undefined, null, "never", "99999999999"]) await expect(check({ exp })).rejects.toThrow(/exp/)
    for (const iat of [undefined, null, "yesterday"]) await expect(check({ iat })).rejects.toThrow(/iat/)
  })
  test("rejects another key id and ambiguous audience without matching authorized party", async () => {
    await expect(check({}, "unknown")).rejects.toThrow(/matching JWK/)
    await expect(check({ aud: ["stohr", "another"] })).rejects.toThrow(/azp/)
    await expect(check({ azp: "another" })).rejects.toThrow(/azp/)
    await expect(check({ aud: ["stohr", "another"], azp: "stohr" })).resolves.toHaveProperty("claims.sub", "123")
  })
  test("discovery cannot replace the configured issuer", async () => {
    await expect(fetchDiscovery(`http://localhost:${server.port}`)).rejects.toThrow(/issuer mismatch/)
  })
  test("backchannel logout binds issuer and audience and rejects replay", async () => {
    const base = `http://localhost:${server.port}/id`
    const ordinary = buildApp(db, TEST_SECRET)
    const user = await callJson(ordinary, "/signup", {
      method: "POST",
      body: { username: "owner", email: "owner@example.com", password: "password123" },
    })
    await upsertFromExternal(
      db,
      {
        provider: "oidc",
        issuer: base,
        subject: "external-sub",
        email: "owner@example.com",
        email_verified: true,
        display_name: null,
      },
      { autoProvision: false },
    )
    const sso = router(
      ...(await setupStohrSso(db, { issuerUrl: base, clientId: "stohr", clientSecret: "test", secret: TEST_SECRET })),
    )
    const claims = {
      iss: base,
      sub: "external-sub",
      nonce: undefined,
      jti: "logout-once",
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    }
    const other = await signed({ ...claims, aud: "another-client" })
    expect(
      (await callJson(sso, "/auth/sso/backchannel-logout", { method: "POST", body: { logout_token: other } })).status,
    ).toBe(400)
    expect((await callJson(ordinary, "/me", { token: user.body.token })).status).toBe(200)
    const valid = await signed(claims)
    expect(
      (await callJson(sso, "/auth/sso/backchannel-logout", { method: "POST", body: { logout_token: valid } })).status,
    ).toBe(200)
    expect((await callJson(ordinary, "/me", { token: user.body.token })).status).toBe(401)
    expect(
      (await callJson(sso, "/auth/sso/backchannel-logout", { method: "POST", body: { logout_token: valid } })).status,
    ).toBe(400)
  })

  test("SSO linking never trusts an unverified email", async () => {
    const app = buildApp(db, TEST_SECRET)
    await callJson(app, "/signup", {
      method: "POST",
      body: { username: "owner", email: "owner@example.com", password: "password123" },
    })
    const cfg = buildStohrSso({
      db,
      issuerUrl: "https://id.example",
      clientId: "stohr",
      clientSecret: "test",
      secret: TEST_SECRET,
    })
    const claims = {
      iss: "https://id.example",
      sub: "stranger",
      aud: "stohr",
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
      email: "owner@example.com",
      email_verified: false,
    }
    await expect(cfg.onAuthenticated(db, claims)).rejects.toThrow(/verified/)
  })
})

describe("browser sign-in binding", () => {
  test("callback state must match a host-only browser cookie", async () => {
    const app = router(get("/start", c => bindLoginState(json(c, 200, {}), "serverstate")))
    const nonce = "11111111-1111-4111-8111-111111111111"
    const response = await app(new Request(`https://app.example/start?browser_nonce=${nonce}`))
    const cookie = response.headers.get("set-cookie")!
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Secure")
    expect(cookie).not.toContain("Domain=")
    const req = new Request("https://app.example/callback", { headers: { cookie: cookie.split(";")[0]! } })
    expect(loginStateNonce(req, "serverstate")).toBe(nonce)
    expect(loginStateNonce(req, "attackerstate")).toBeNull()
    expect(loginStateNonce(new Request(req.url), "serverstate")).toBeNull()
  })
})

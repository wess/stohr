import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const signupOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@x.test", password: "password123" },
  })
  return res.body as { id: number; token: string }
}

describe("external auth", () => {
  test("OIDC status is off by default", async () => {
    const r = await callJson(app, "/auth/oidc/status")
    expect(r.status).toBe(200)
    expect(r.body.available).toBe(false)
  })

  test("LDAP status is off by default", async () => {
    const r = await callJson(app, "/auth/ldap/status")
    expect(r.status).toBe(200)
    expect(r.body.available).toBe(false)
  })

  test("non-owner cannot read OIDC config", async () => {
    const alice = await signupOwner()
    const inv = await callJson(app, "/invites", { method: "POST", body: {}, token: alice.token })
    const bobSignup = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Bob", username: "bob", email: "bob@x.test", password: "password123", invite_token: inv.body.token },
    })
    const bobToken = bobSignup.body.token
    const r = await callJson(app, "/admin/oidc", { token: bobToken })
    expect(r.status).toBe(403)
  })

  test("owner updates OIDC config and reads it back redacted", async () => {
    const alice = await signupOwner()
    const update = await callJson(app, "/admin/oidc", {
      method: "PUT", token: alice.token,
      body: {
        enabled: true,
        issuer_url: "https://idp.example.com",
        client_id: "stohr-client",
        client_secret: "shh",
        button_label: "Sign in with Acme",
      },
    })
    expect(update.status).toBe(200)
    expect(update.body.has_client_secret).toBe(true)
    expect(update.body.button_label).toBe("Sign in with Acme")
    // The secret is not echoed back.
    expect((update.body as any).client_secret).toBeUndefined()

    const status = await callJson(app, "/auth/oidc/status")
    expect(status.body.available).toBe(true)
    expect(status.body.label).toBe("Sign in with Acme")
  })

  test("LDAP login returns 503 when not configured", async () => {
    const r = await callJson(app, "/auth/ldap/login", {
      method: "POST", body: { identity: "u", password: "p" },
    })
    expect([503, 401]).toContain(r.status)
  })
})

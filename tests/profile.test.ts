import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const signupAlice = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@example.com", password: "password123" },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string }
}

describe("PATCH /me", () => {
  test("email change demands the current password", async () => {
    const alice = await signupAlice()

    const missing = await callJson(app, "/me", {
      method: "PATCH",
      token: alice.token,
      body: { email: "new@example.com" },
    })
    expect(missing.status).toBe(422)

    const wrong = await callJson(app, "/me", {
      method: "PATCH",
      token: alice.token,
      body: { email: "new@example.com", current_password: "nope-nope-nope" },
    })
    expect(wrong.status).toBe(401)

    const unchanged = await callJson(app, "/me", { token: alice.token })
    expect(unchanged.body.email).toBe("alice@example.com")

    const ok = await callJson(app, "/me", {
      method: "PATCH",
      token: alice.token,
      body: { email: "new@example.com", current_password: "password123" },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.email).toBe("new@example.com")
    expect(ok.body.token).toBeTruthy()

    // the old session is gone, the replacement works
    const stale = await callJson(app, "/me", { token: alice.token })
    expect(stale.status).toBe(401)
    const fresh = await callJson(app, "/me", { token: ok.body.token })
    expect(fresh.status).toBe(200)
  })

  test("username change demands the current password too", async () => {
    const alice = await signupAlice()
    const res = await callJson(app, "/me", { method: "PATCH", token: alice.token, body: { username: "alice2" } })
    expect(res.status).toBe(422)
    const ok = await callJson(app, "/me", {
      method: "PATCH",
      token: alice.token,
      body: { username: "alice2", currentPassword: "password123" },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.username).toBe("alice2")
  })

  test("name and discoverable changes need no password", async () => {
    const alice = await signupAlice()
    const name = await callJson(app, "/me", { method: "PATCH", token: alice.token, body: { name: "Alicia" } })
    expect(name.status).toBe(200)
    expect(name.body.name).toBe("Alicia")
    // the JWT carries the name, so a session caller gets a replacement
    expect(name.body.token).toBeTruthy()

    const toggle = await callJson(app, "/me", {
      method: "PATCH",
      token: name.body.token,
      body: { discoverable: false },
    })
    expect(toggle.status).toBe(200)
    expect(toggle.body.discoverable).toBe(false)
    expect(toggle.body.token).toBeUndefined()
  })

  test("a PAT never receives a session token", async () => {
    const alice = await signupAlice()
    const pat = await callJson(app, "/me/apps", { method: "POST", token: alice.token, body: { name: "cli" } })
    expect(pat.status).toBe(201)
    const patToken = pat.body.token as string

    const res = await callJson(app, "/me", { method: "PATCH", token: patToken, body: { name: "Via PAT" } })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe("Via PAT")
    expect(res.body.token).toBeUndefined()

    // identity claims changed, so the browser session was revoked; the PAT
    // itself keeps working
    const stale = await callJson(app, "/me", { token: alice.token })
    expect(stale.status).toBe(401)
    const viaPat = await callJson(app, "/me", { token: patToken })
    expect(viaPat.status).toBe(200)
  })
})

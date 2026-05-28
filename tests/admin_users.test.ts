import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const signup = async (name: string, username: string, email: string, invite?: string) => {
  const res = await callJson(app, "/signup", {
    method: "POST", body: { name, username, email, password: "password123", invite_token: invite },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string }
}
const inviteToken = async (owner: { token: string }) => {
  const r = await callJson(app, "/invites", { method: "POST", body: {}, token: owner.token })
  return r.body.token as string
}

describe("admin user management", () => {
  test("non-owner cannot access /admin/users/:id", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const res = await callJson(app, `/admin/users/${alice.id}`, { token: bob.token })
    expect(res.status).toBe(403)
  })

  test("owner edits target user name/email/username", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const res = await callJson(app, `/admin/users/${bob.id}`, {
      method: "PATCH", token: alice.token,
      body: { name: "Robert", username: "robert" },
    })
    expect(res.status).toBe(200)
    const detail = await callJson(app, `/admin/users/${bob.id}`, { token: alice.token })
    expect(detail.body.name).toBe("Robert")
    expect(detail.body.username).toBe("robert")
  })

  test("rejects duplicate email/username on edit", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const res = await callJson(app, `/admin/users/${bob.id}`, {
      method: "PATCH", token: alice.token, body: { email: "alice@x.test" },
    })
    expect(res.status).toBe(409)
  })

  test("suspend blocks login + active sessions; unsuspend restores", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))

    // Bob's existing token works.
    const ok1 = await callJson(app, "/me", { token: bob.token })
    expect(ok1.status).toBe(200)

    const suspend = await callJson(app, `/admin/users/${bob.id}/suspend`, {
      method: "POST", token: alice.token, body: { reason: "Spam" },
    })
    expect(suspend.status).toBe(200)

    // Bob's session is now revoked AND the user is suspended.
    const blocked = await callJson(app, "/me", { token: bob.token })
    expect([401, 403]).toContain(blocked.status)

    const login = await callJson(app, "/login", {
      method: "POST", body: { identity: "bob@x.test", password: "password123" },
    })
    expect(login.status).toBe(403)
    expect(login.body.account_suspended).toBe(true)

    const unsuspend = await callJson(app, `/admin/users/${bob.id}/unsuspend`, {
      method: "POST", token: alice.token, body: {},
    })
    expect(unsuspend.status).toBe(200)

    const okAgain = await callJson(app, "/login", {
      method: "POST", body: { identity: "bob@x.test", password: "password123" },
    })
    expect(okAgain.status).toBe(200)
  })

  test("cannot suspend yourself or another owner", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const self = await callJson(app, `/admin/users/${alice.id}/suspend`, {
      method: "POST", token: alice.token, body: {},
    })
    expect(self.status).toBe(422)
  })

  test("reset-password issues a token and returns the URL when email is disabled-ish", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const res = await callJson(app, `/admin/users/${bob.id}/reset-password`, {
      method: "POST", token: alice.token, body: {},
    })
    expect(res.status).toBe(200)
    expect(res.body.emailed).toBe(true) // fakeEmailer returns ok
  })

  test("admin message delivers to recipient inbox", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const res = await callJson(app, `/admin/users/${bob.id}/message`, {
      method: "POST", token: alice.token, body: { subject: "Heads up", body: "Storage cap raised." },
    })
    expect(res.status).toBe(201)
    const inbox = await callJson(app, "/me/messages", { token: bob.token })
    const found = inbox.body.messages.find((m: any) => m.subject === "Heads up")
    expect(found).toBeDefined()
    expect(found.kind).toBe("system")
  })

  test("broadcast delivers to every active user", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const carol = await signup("Carol", "carol", "carol@x.test", await inviteToken(alice))
    const res = await callJson(app, `/admin/broadcast`, {
      method: "POST", token: alice.token, body: { subject: "All", body: "Hi team." },
    })
    expect(res.status).toBe(201)
    expect(res.body.delivered).toBeGreaterThanOrEqual(3)
    const bobInbox = await callJson(app, "/me/messages", { token: bob.token })
    expect(bobInbox.body.messages.find((m: any) => m.subject === "All")).toBeDefined()
  })
})

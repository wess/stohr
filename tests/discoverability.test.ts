import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { sha256Hex } from "../src/util/token.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

// Stohr is invite-only after the first user. To sign up subsequent users in
// tests we mint an invite directly against the DB and pass its plaintext
// through /signup.
const mintInvite = async (ownerId: number): Promise<string> => {
  const t = `invitetoken-${Math.random().toString(36).slice(2, 12)}`
  await db.execute(
    from("invites").insert({ token_hash: sha256Hex(t), invited_by: ownerId }),
  )
  return t
}

const signupOwner = async (opts: { email?: string; username?: string; name?: string } = {}) => {
  const email = opts.email ?? "owner@example.com"
  const username = opts.username ?? "owner"
  const name = opts.name ?? "Owner"
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { email, username, name, password: "password123" },
  })
  return { ...(res.body as { id: number; token: string }), email, username, name }
}

const signupInvited = async (
  ownerId: number,
  opts: { email?: string; username?: string; name?: string } = {},
) => {
  const inviteToken = await mintInvite(ownerId)
  const email = opts.email ?? `u${Date.now()}@example.com`
  const username = opts.username ?? `user${Math.random().toString(36).slice(2, 8)}`
  const name = opts.name ?? "Invited"
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { email, username, name, password: "password123", invite_token: inviteToken },
  })
  return { ...(res.body as { id: number; token: string }), email, username, name }
}

describe("/users/search privacy", () => {
  test("no longer matches by email substring (enumeration plug)", async () => {
    const owner = await signupOwner()
    const a = await signupInvited(owner.id, { email: "alice@acme.io", username: "alice" })
    await signupInvited(owner.id, { email: "bob@acme.io", username: "bob" })

    // Email-domain probe should return zero results — pre-fix, it would have
    // returned every @acme.io account.
    const res = await callJson(app, "/users/search?q=@acme.io", { method: "GET", token: a.token })
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  test("still matches by username and display name", async () => {
    const owner = await signupOwner()
    const a = await signupInvited(owner.id, { username: "alice", name: "Alice" })
    await signupInvited(owner.id, { username: "bob", name: "Bob" })

    const byUsername = await callJson(app, "/users/search?q=bob", { method: "GET", token: a.token })
    expect(byUsername.body.map((u: any) => u.username)).toContain("bob")

    const byName = await callJson(app, "/users/search?q=Bob", { method: "GET", token: a.token })
    expect(byName.body.map((u: any) => u.name)).toContain("Bob")
  })

  test("hides users who set discoverable=false", async () => {
    const owner = await signupOwner()
    const a = await signupInvited(owner.id, { username: "alice", name: "Alice" })
    const b = await signupInvited(owner.id, { username: "stealth", name: "Stealth Bob" })

    // Confirm Bob is visible by default.
    const before = await callJson(app, "/users/search?q=stealth", { method: "GET", token: a.token })
    expect(before.body.map((u: any) => u.username)).toContain("stealth")

    // Bob opts out.
    const patch = await callJson(app, "/me", {
      method: "PATCH",
      token: b.token,
      body: { discoverable: false },
    })
    expect(patch.status).toBe(200)
    expect(patch.body.discoverable).toBe(false)
    // Privacy-only patch should NOT churn the session.
    expect(patch.body.token).toBeUndefined()

    const after = await callJson(app, "/users/search?q=stealth", { method: "GET", token: a.token })
    expect(after.body).toEqual([])
  })

  test("hides soft-deleted users", async () => {
    const owner = await signupOwner()
    const a = await signupInvited(owner.id, { username: "alice" })
    const b = await signupInvited(owner.id, { username: "ghostuser" })

    await callJson(app, "/me", { method: "DELETE", token: b.token, body: { password: "password123" } })

    const res = await callJson(app, "/users/search?q=ghostuser", { method: "GET", token: a.token })
    expect(res.body).toEqual([])
  })
})

describe("GET /u/:username privacy", () => {
  test("returns 404 for non-discoverable users (third party)", async () => {
    const owner = await signupOwner()
    const a = await signupInvited(owner.id, { username: "alice" })
    const b = await signupInvited(owner.id, { username: "stealth" })

    await callJson(app, "/me", {
      method: "PATCH",
      token: b.token,
      body: { discoverable: false },
    })

    const res = await callJson(app, "/u/stealth", { method: "GET", token: a.token })
    expect(res.status).toBe(404)
  })

  test("a non-discoverable user can still look up their own profile", async () => {
    const owner = await signupOwner()
    const b = await signupInvited(owner.id, { username: "stealth" })
    await callJson(app, "/me", {
      method: "PATCH",
      token: b.token,
      body: { discoverable: false },
    })

    const res = await callJson(app, "/u/stealth", { method: "GET", token: b.token })
    expect(res.status).toBe(200)
    expect(res.body.username).toBe("stealth")
  })

  test("returns 404 for soft-deleted users even if discoverable=true", async () => {
    const owner = await signupOwner()
    const a = await signupInvited(owner.id, { username: "alice" })
    const b = await signupInvited(owner.id, { username: "ghostuser" })

    await callJson(app, "/me", { method: "DELETE", token: b.token, body: { password: "password123" } })

    const res = await callJson(app, "/u/ghostuser", { method: "GET", token: a.token })
    expect(res.status).toBe(404)
  })
})

describe("PATCH /me discoverable validation", () => {
  test("non-boolean values are ignored, not stored", async () => {
    const u = await signupOwner()
    // Pass a string — should be ignored, treated as if discoverable wasn't supplied.
    const res = await callJson(app, "/me", {
      method: "PATCH",
      token: u.token,
      body: { discoverable: "yes" },
    })
    // No other fields supplied either, so 422.
    expect(res.status).toBe(422)
  })

  test("toggling false then true round-trips", async () => {
    const u = await signupOwner()
    let r = await callJson(app, "/me", { method: "PATCH", token: u.token, body: { discoverable: false } })
    expect(r.body.discoverable).toBe(false)
    r = await callJson(app, "/me", { method: "PATCH", token: u.token, body: { discoverable: true } })
    expect(r.body.discoverable).toBe(true)
  })
})

describe("GET /me", () => {
  test("returns the discoverable flag", async () => {
    const u = await signupOwner()
    const res = await callJson(app, "/me", { method: "GET", token: u.token })
    expect(res.status).toBe(200)
    expect(res.body.discoverable).toBe(true)
  })
})

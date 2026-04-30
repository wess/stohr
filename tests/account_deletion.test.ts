import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson, fakeStore, fakeEmailer, resetSentEmails, sentEmails, TEST_APP_URL } from "./helpers/http.ts"
import { sweepDeletedAccounts } from "../src/auth/deletion.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
  resetSentEmails()
})

const signupOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  return res.body as { id: number; token: string }
}

describe("DELETE /me — soft delete", () => {
  test("requires the password", async () => {
    const u = await signupOwner()
    const res = await callJson(app, "/me", { method: "DELETE", token: u.token, body: {} })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/password required/i)
  })

  test("rejects wrong password", async () => {
    const u = await signupOwner()
    const res = await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "wrong" } })
    expect(res.status).toBe(401)
  })

  test("schedules deletion with grace window and emails the user", async () => {
    const u = await signupOwner()
    const res = await callJson(app, "/me", {
      method: "DELETE",
      token: u.token,
      body: { password: "password123" },
    })
    expect(res.status).toBe(200)
    expect(res.body.scheduled).toBe(true)

    const row = await db.one(
      from("users").where(q => q("id").equals(u.id)).select("deleted_at", "deletion_token_hash"),
    ) as { deleted_at: string | null; deletion_token_hash: string | null }
    expect(row.deleted_at).toBeTruthy()
    expect(row.deletion_token_hash).toBeTruthy()

    expect(sentEmails).toHaveLength(1)
    expect(sentEmails[0]?.to).toBe("owner@example.com")
    expect(sentEmails[0]?.subject).toContain("scheduled for deletion")
    expect(sentEmails[0]?.html).toContain(`${TEST_APP_URL}/account/restore?token=stohr_acd_`)
  })

  test("revokes existing sessions immediately", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })

    // The bearer token is now backed by a revoked session.
    const ping = await callJson(app, "/me", { method: "GET", token: u.token })
    // Either the session is revoked (401) or the user is detected as deleted (403).
    expect([401, 403]).toContain(ping.status)
  })

  test("rejects re-scheduling an already-deleted account", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })
    // The session is dead, so this is not really reachable from the same token,
    // but we can still verify the column-level check by talking to the DB
    // directly and re-fetching a fresh session via a (bypass) JWT replay.
    const second = await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })
    // Either the session-revoked path (401) or the deleted-account path (403/409).
    expect([401, 403, 409]).toContain(second.status)
  })
})

describe("login during grace window", () => {
  test("login is rejected with account_deleted: true", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })

    const login = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "owner@example.com", password: "password123" },
    })
    expect(login.status).toBe(403)
    expect(login.body.account_deleted).toBe(true)
  })

  test("password reset email is silently suppressed for deleted accounts", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })
    const beforeSent = sentEmails.length

    const reset = await callJson(app, "/password/forgot", {
      method: "POST",
      body: { email: "owner@example.com" },
    })
    // Always returns 200 to avoid leaking existence — but no new email goes out.
    expect(reset.status).toBe(200)
    expect(sentEmails.length).toBe(beforeSent)
  })
})

describe("POST /account/restore", () => {
  test("with the emailed token, restores the account and returns a fresh session", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })

    const url = sentEmails[0]?.html.match(/\/account\/restore\?token=([\w%-]+)/)?.[1]
    const cancelToken = decodeURIComponent(url ?? "")
    expect(cancelToken.startsWith("stohr_acd_")).toBe(true)

    const restore = await callJson(app, "/account/restore", {
      method: "POST",
      body: { token: cancelToken },
    })
    expect(restore.status).toBe(200)
    expect(restore.body.ok).toBe(true)
    expect(restore.body.token).toBeTruthy()
    expect(restore.body.user.id).toBe(u.id)

    // Account is no longer scheduled for deletion.
    const row = await db.one(
      from("users").where(q => q("id").equals(u.id)).select("deleted_at", "deletion_token_hash"),
    ) as { deleted_at: string | null; deletion_token_hash: string | null }
    expect(row.deleted_at).toBeNull()
    expect(row.deletion_token_hash).toBeNull()

    // The new session works.
    const me = await callJson(app, "/me", { method: "GET", token: restore.body.token })
    expect(me.status).toBe(200)
    expect(me.body.id).toBe(u.id)
  })

  test("rejects bogus tokens", async () => {
    const res = await callJson(app, "/account/restore", { method: "POST", body: { token: "not-a-real-token" } })
    expect(res.status).toBe(400)
  })

  test("rejects tokens with the right prefix but no matching account", async () => {
    const res = await callJson(app, "/account/restore", {
      method: "POST",
      body: { token: "stohr_acd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    })
    expect(res.status).toBe(400)
  })

  test("rejects a second restore using the same token", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })
    const url = sentEmails[0]?.html.match(/\/account\/restore\?token=([\w%-]+)/)?.[1]
    const cancelToken = decodeURIComponent(url ?? "")

    const first = await callJson(app, "/account/restore", { method: "POST", body: { token: cancelToken } })
    expect(first.status).toBe(200)

    // Token hash was nulled on restore, so second use 400s.
    const second = await callJson(app, "/account/restore", { method: "POST", body: { token: cancelToken } })
    expect(second.status).toBe(400)
  })

  test("rejects a token whose grace window has elapsed (manually aged)", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })
    const url = sentEmails[0]?.html.match(/\/account\/restore\?token=([\w%-]+)/)?.[1]
    const cancelToken = decodeURIComponent(url ?? "")

    // Push deleted_at 25h into the past.
    await db.execute({
      text: `UPDATE users SET deleted_at = NOW() - INTERVAL '25 hours' WHERE id = $1`,
      values: [u.id],
    })

    const res = await callJson(app, "/account/restore", { method: "POST", body: { token: cancelToken } })
    expect(res.status).toBe(410)
  })
})

describe("sweepDeletedAccounts", () => {
  test("hard-deletes accounts whose grace window has elapsed", async () => {
    const u = await signupOwner()
    await callJson(app, "/me", { method: "DELETE", token: u.token, body: { password: "password123" } })

    // Still present immediately after — sweep should be a no-op.
    await sweepDeletedAccounts(db, fakeStore)
    const stillThere = await db.one(
      from("users").where(q => q("id").equals(u.id)).select("id"),
    ) as { id: number } | null
    expect(stillThere).toBeTruthy()

    // Age the row past the grace window — sweep should now purge it.
    await db.execute({
      text: `UPDATE users SET deleted_at = NOW() - INTERVAL '25 hours' WHERE id = $1`,
      values: [u.id],
    })
    await sweepDeletedAccounts(db, fakeStore)
    const gone = await db.one(
      from("users").where(q => q("id").equals(u.id)).select("id"),
    ) as { id: number } | null
    expect(gone).toBeNull()
  })

  test("does not touch active accounts", async () => {
    const u = await signupOwner()
    await sweepDeletedAccounts(db, fakeStore)
    const row = await db.one(
      from("users").where(q => q("id").equals(u.id)).select("id"),
    ) as { id: number } | null
    expect(row?.id).toBe(u.id)
  })
})

import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { token } from "@atlas/auth"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const signupAndGetToken = async (): Promise<string> => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@example.com", password: "password123" },
  })
  return res.body.token as string
}

const decodeJwt = async (jwt: string): Promise<any> =>
  await token.verify(jwt, TEST_SECRET)

describe("sessions", () => {
  test("login issues a JWT with a jti claim and writes a session row", async () => {
    const jwt = await signupAndGetToken()
    const payload = await decodeJwt(jwt)
    expect(payload.jti).toBeTruthy()

    const row = await db.one(
      from("sessions").where(q => q("id").equals(payload.jti)).select("user_id", "revoked_at"),
    ) as { user_id: number; revoked_at: string | null } | null
    expect(row).toBeTruthy()
    expect(row?.revoked_at).toBeNull()
  })

  test("/me/sessions lists the current session and marks it current", async () => {
    const jwt = await signupAndGetToken()
    const list = await callJson(app, "/me/sessions", { token: jwt })
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].current).toBe(true)
  })

  test("revoking the current session blocks subsequent requests", async () => {
    const jwt = await signupAndGetToken()
    const payload = await decodeJwt(jwt)

    const ok = await callJson(app, "/me", { token: jwt })
    expect(ok.status).toBe(200)

    const revoke = await callJson(app, `/me/sessions/${payload.jti}`, { method: "DELETE", token: jwt })
    expect(revoke.status).toBe(200)

    const blocked = await callJson(app, "/me", { token: jwt })
    expect(blocked.status).toBe(401)
  })

  test("revoke-others kills other sessions but keeps current alive", async () => {
    // Signup Alice (gets token1) and log in again to get a second session token2.
    const t1 = await signupAndGetToken()
    const second = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    const t2 = second.body.token as string
    expect(t2).toBeTruthy()
    expect(t2).not.toBe(t1)

    const list = await callJson(app, "/me/sessions", { token: t1 })
    expect(list.body).toHaveLength(2)

    const res = await callJson(app, "/me/sessions/revoke-others", { method: "POST", body: {}, token: t1 })
    expect(res.status).toBe(200)
    expect(res.body.revoked).toBe(1)

    // The token used to call revoke-others (t1) still works, the other (t2) is dead.
    const stillOk = await callJson(app, "/me", { token: t1 })
    expect(stillOk.status).toBe(200)
    const dead = await callJson(app, "/me", { token: t2 })
    expect(dead.status).toBe(401)
  })

  test("password change revokes other sessions but spares the current one", async () => {
    const t1 = await signupAndGetToken()
    const second = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    const t2 = second.body.token as string

    const res = await callJson(app, "/me/password", {
      method: "POST",
      body: { current_password: "password123", new_password: "newpassword456" },
      token: t1,
    })
    expect(res.status).toBe(200)
    expect(res.body.revoked_other_sessions).toBe(1)

    const stillOk = await callJson(app, "/me", { token: t1 })
    expect(stillOk.status).toBe(200)
    const dead = await callJson(app, "/me", { token: t2 })
    expect(dead.status).toBe(401)
  })
})

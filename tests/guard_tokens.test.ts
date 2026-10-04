import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { hash, token } from "@atlas/auth"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { generateBackupCodes, generateSecret, totpAt } from "../src/security/totp.ts"

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

// Every JWT the app signs uses the same secret. Only session and OAuth access
// tokens are bearer credentials; anything else shaped must bounce at the guard.
describe("bearer token shape", () => {
  test("a real session token is accepted", async () => {
    const alice = await signupAlice()
    const me = await callJson(app, "/me", { token: alice.token })
    expect(me.status).toBe(200)
  })

  test("an MFA challenge token is not a login", async () => {
    const alice = await signupAlice()
    const secret = generateSecret()
    const codes = await Promise.all(generateBackupCodes(2).map(c => hash(c)))
    await db.execute(
      from("users")
        .where(q => q("id").equals(alice.id))
        .update({ totp_secret: secret, totp_enabled: true, totp_backup_codes: JSON.stringify(codes) }),
    )
    const login = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    expect(login.body.mfa_required).toBe(true)
    const challenge = login.body.mfa_token as string

    const me = await callJson(app, "/me", { token: challenge })
    expect(me.status).toBe(401)

    // the challenge still completes the login it was issued for
    const done = await callJson(app, "/login/mfa", {
      method: "POST",
      body: { mfa_token: challenge, code: totpAt(secret) },
    })
    expect(done.status).toBe(200)
  })

  test("a JWT with a kind claim is rejected even with id + jti", async () => {
    const alice = await signupAlice()
    const forged = await token.sign({ kind: "mfa", id: alice.id, jti: "abc" }, TEST_SECRET, { expiresIn: 60 })
    const me = await callJson(app, "/me", { token: forged })
    expect(me.status).toBe(401)
  })

  test("a JWT without a jti is rejected", async () => {
    const alice = await signupAlice()
    const forged = await token.sign(
      { id: alice.id, email: "alice@example.com", username: "alice", name: "Alice", is_owner: true },
      TEST_SECRET,
      { expiresIn: 60 },
    )
    const me = await callJson(app, "/me", { token: forged })
    expect(me.status).toBe(401)
  })

  test("a JWT whose id is not a number is rejected", async () => {
    const alice = await signupAlice()
    const forged = await token.sign({ id: String(alice.id), jti: "abc" }, TEST_SECRET, { expiresIn: 60 })
    const me = await callJson(app, "/me", { token: forged })
    expect(me.status).toBe(401)
  })

  test("a well-formed JWT with no session row is rejected", async () => {
    const alice = await signupAlice()
    const forged = await token.sign({ id: alice.id, jti: "not-a-session" }, TEST_SECRET, { expiresIn: 60 })
    const me = await callJson(app, "/me", { token: forged })
    expect(me.status).toBe(401)
  })
})

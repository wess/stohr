import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { generateBackupCodes, generateSecret, totpAt } from "../src/security/totp.ts"
import { hash } from "@atlas/auth"

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
  expect(res.body.token).toBeDefined()
  return res.body as { id: number; token: string }
}

describe("signup", () => {
  test("first signup becomes the owner", async () => {
    const { body } = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Alice", username: "alice", email: "alice@example.com", password: "password123" },
    })
    expect(body.is_owner).toBe(true)
    expect(body.token).toBeTruthy()
  })

  test("second signup without invite is rejected", async () => {
    await signupAlice()
    const res = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Bob", username: "bob", email: "bob@example.com", password: "password123" },
    })
    expect(res.status).toBe(403)
  })

  test("rejects duplicate email", async () => {
    await signupAlice()
    const res = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Bob", username: "bob", email: "alice@example.com", password: "password123", invite_token: "x" },
    })
    expect([403, 409]).toContain(res.status)
  })

  test("rejects short passwords", async () => {
    const res = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Alice", username: "alice", email: "alice@example.com", password: "short" },
    })
    expect(res.status).toBe(422)
  })
})

describe("login", () => {
  beforeEach(async () => {
    await signupAlice()
  })

  test("good creds return token", async () => {
    const res = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
    expect(res.body.mfa_required).toBeUndefined()
  })

  test("login by username also works", async () => {
    const res = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice", password: "password123" },
    })
    expect(res.status).toBe(200)
  })

  test("wrong password returns generic error", async () => {
    const res = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "wrong" },
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe("Invalid credentials")
  })

  test("unknown user returns the same generic error", async () => {
    const res = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "nobody@example.com", password: "whatever" },
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe("Invalid credentials")
  })

  test("rate limits per-account after 5 bad attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await callJson(app, "/login", {
        method: "POST",
        body: { identity: "alice@example.com", password: "wrong" },
        ip: "10.0.0.1",
      })
    }
    const sixth = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
      ip: "10.0.0.1",
    })
    expect(sixth.status).toBe(429)
    expect(sixth.body.retry_after).toBeGreaterThan(0)
  })

  test("audit_events records ok + fail entries", async () => {
    await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "wrong" },
    })
    await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    // Audit is fire-and-forget, give it a tick.
    await new Promise(r => setTimeout(r, 50))
    const events = await db.all(
      from("audit_events").select("event").orderBy("created_at", "ASC"),
    ) as Array<{ event: string }>
    const names = events.map(e => e.event)
    expect(names).toContain("login.fail")
    expect(names).toContain("login.ok")
    expect(names).toContain("signup.ok")
  })
})

describe("MFA login", () => {
  // Helper to enable MFA inline by writing the user row directly.
  const enableMfaFor = async (userId: number) => {
    const secret = generateSecret()
    const codes = generateBackupCodes(3)
    const hashed = await Promise.all(codes.map(c => hash(c)))
    await db.execute(
      from("users").where(q => q("id").equals(userId)).update({
        totp_secret: secret,
        totp_enabled: true,
        totp_backup_codes: JSON.stringify(hashed),
      }),
    )
    return { secret, codes }
  }

  test("login returns mfa challenge instead of full token", async () => {
    const { id } = await signupAlice()
    await enableMfaFor(id)
    const res = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    expect(res.status).toBe(200)
    expect(res.body.mfa_required).toBe(true)
    expect(res.body.mfa_token).toBeTruthy()
    expect(res.body.token).toBeUndefined()
  })

  test("/login/mfa with valid TOTP code completes", async () => {
    const { id } = await signupAlice()
    const { secret } = await enableMfaFor(id)
    const challenge = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    const code = totpAt(secret)
    const res = await callJson(app, "/login/mfa", {
      method: "POST",
      body: { mfa_token: challenge.body.mfa_token, code },
    })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
  })

  test("/login/mfa rejects wrong code", async () => {
    const { id } = await signupAlice()
    await enableMfaFor(id)
    const challenge = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    const res = await callJson(app, "/login/mfa", {
      method: "POST",
      body: { mfa_token: challenge.body.mfa_token, code: "000000" },
    })
    expect(res.status).toBe(401)
  })

  test("backup code consumes a slot", async () => {
    const { id } = await signupAlice()
    const { codes } = await enableMfaFor(id)
    const challenge = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    const used = codes[0]!
    const ok = await callJson(app, "/login/mfa", {
      method: "POST",
      body: { mfa_token: challenge.body.mfa_token, backup_code: used },
    })
    expect(ok.status).toBe(200)

    // Re-issue a new challenge and try the same backup code: it should fail.
    const challenge2 = await callJson(app, "/login", {
      method: "POST",
      body: { identity: "alice@example.com", password: "password123" },
    })
    const reuse = await callJson(app, "/login/mfa", {
      method: "POST",
      body: { mfa_token: challenge2.body.mfa_token, backup_code: used },
    })
    expect(reuse.status).toBe(401)
  })
})

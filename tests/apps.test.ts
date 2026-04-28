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

const signupAndGetToken = async (): Promise<string> => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@example.com", password: "password123" },
  })
  return res.body.token as string
}

describe("personal access tokens (apps)", () => {
  test("create returns the token only on creation", async () => {
    const jwt = await signupAndGetToken()
    const create = await callJson(app, "/me/apps", {
      method: "POST",
      body: { name: "Flutter", description: "mobile" },
      token: jwt,
    })
    expect(create.status).toBe(201)
    expect(create.body.token).toMatch(/^stohr_pat_/)
    expect(create.body.token_prefix).toMatch(/^stohr_pat_/)

    const list = await callJson(app, "/me/apps", { token: jwt })
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0].token).toBeUndefined() // never re-shown
    expect(list.body[0].token_prefix).toBe(create.body.token_prefix)
  })

  test("name is required", async () => {
    const jwt = await signupAndGetToken()
    const res = await callJson(app, "/me/apps", {
      method: "POST",
      body: {},
      token: jwt,
    })
    expect(res.status).toBe(422)
  })

  test("PAT authenticates against authed routes", async () => {
    const jwt = await signupAndGetToken()
    const create = await callJson(app, "/me/apps", {
      method: "POST",
      body: { name: "ci" },
      token: jwt,
    })
    const pat = create.body.token as string

    const me = await callJson(app, "/me", { token: pat })
    expect(me.status).toBe(200)
    expect(me.body.username).toBe("alice")
  })

  test("revoking an app makes its PAT invalid", async () => {
    const jwt = await signupAndGetToken()
    const create = await callJson(app, "/me/apps", {
      method: "POST",
      body: { name: "ci" },
      token: jwt,
    })
    const pat = create.body.token as string
    const id = create.body.id as number

    const before = await callJson(app, "/me", { token: pat })
    expect(before.status).toBe(200)

    const revoke = await callJson(app, `/me/apps/${id}`, { method: "DELETE", token: jwt })
    expect(revoke.status).toBe(200)

    const after = await callJson(app, "/me", { token: pat })
    expect(after.status).toBe(401)
  })

  test("a malformed PAT prefix is rejected", async () => {
    const me = await callJson(app, "/me", { token: "stohr_pat_not-a-real-token" })
    expect(me.status).toBe(401)
  })
})

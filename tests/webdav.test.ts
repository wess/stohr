import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { buildApp, callJson, callRaw } from "./helpers/http.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const EMAIL = "owner@example.com"

// First signup is the owner, so its token can flip instance settings on.
const setup = async () => {
  const signup = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: EMAIL, password: "password123" },
  })
  const jwt = signup.body.token as string
  await callJson(app, "/admin/settings", { method: "PATCH", body: { webdav_enabled: true }, token: jwt })
  const pat = await callJson(app, "/me/apps", { method: "POST", body: { name: "webdav" }, token: jwt })
  return { jwt, pat: pat.body.token as string }
}

describe("webdav", () => {
  test("PROPFIND on root returns 207 and lists folders", async () => {
    const { jwt, pat } = await setup()
    await callJson(app, "/folders", { method: "POST", body: { name: "Documents" }, token: jwt })

    const res = await callRaw(app, "/webdav/", {
      method: "PROPFIND",
      basic: { user: EMAIL, pass: pat },
      headers: { depth: "1" },
    })
    expect(res.status).toBe(207)
    expect(res.text).toContain("<D:multistatus")
    expect(res.text).toContain("Documents")
    expect(res.text).toContain("<D:collection/>")
  })

  test("PUT then GET round-trips a file", async () => {
    const { pat } = await setup()
    const put = await callRaw(app, "/webdav/hello.txt", {
      method: "PUT",
      body: "hello webdav",
      basic: { user: EMAIL, pass: pat },
      headers: { "content-type": "text/plain" },
    })
    expect(put.status).toBe(201)

    const get = await callRaw(app, "/webdav/hello.txt", {
      method: "GET",
      basic: { user: EMAIL, pass: pat },
    })
    expect(get.status).toBe(200)
    expect(get.text).toBe("hello webdav")

    // Same-name PUT overwrites and returns 204 (archives a version).
    const put2 = await callRaw(app, "/webdav/hello.txt", {
      method: "PUT",
      body: "second revision",
      basic: { user: EMAIL, pass: pat },
      headers: { "content-type": "text/plain" },
    })
    expect(put2.status).toBe(204)
  })

  test("Basic auth rejects a bad PAT", async () => {
    await setup()
    const res = await callRaw(app, "/webdav/", {
      method: "PROPFIND",
      basic: { user: EMAIL, pass: "stohr_pat_not-a-real-token" },
      headers: { depth: "0" },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain("Basic")
  })

  test("missing credentials are rejected", async () => {
    await setup()
    const res = await callRaw(app, "/webdav/", { method: "PROPFIND", headers: { depth: "0" } })
    expect(res.status).toBe(401)
  })

  test("OPTIONS advertises DAV support", async () => {
    await setup()
    const res = await callRaw(app, "/webdav/", { method: "OPTIONS" })
    expect(res.status).toBe(200)
    expect(res.headers.get("dav")).toContain("1")
    expect(res.headers.get("allow")).toContain("PROPFIND")
  })

  test("MKCOL creates a folder reachable via PROPFIND", async () => {
    const { pat } = await setup()
    const mkcol = await callRaw(app, "/webdav/Projects", {
      method: "MKCOL",
      basic: { user: EMAIL, pass: pat },
    })
    expect(mkcol.status).toBe(201)

    const res = await callRaw(app, "/webdav/", {
      method: "PROPFIND",
      basic: { user: EMAIL, pass: pat },
      headers: { depth: "1" },
    })
    expect(res.text).toContain("Projects")
  })
})

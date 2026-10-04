import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
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
  return { jwt, pat: pat.body.token as string, userId: signup.body.id as number }
}

const dav = (pat: string, method: string, path: string, extra: { body?: string; headers?: Record<string, string> } = {}) =>
  callRaw(app, path, { method, basic: { user: EMAIL, pass: pat }, body: extra.body, headers: extra.headers })

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

  test("GET serves the body as an attachment with nosniff", async () => {
    const { pat } = await setup()
    await dav(pat, "PUT", "/webdav/page.html", { body: "<script>1</script>", headers: { "content-type": "text/html" } })
    const get = await dav(pat, "GET", "/webdav/page.html")
    expect(get.status).toBe(200)
    expect(get.headers.get("content-disposition")).toContain("attachment")
    expect(get.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("MOVE refuses to put a folder inside its own subtree", async () => {
    const { pat } = await setup()
    expect((await dav(pat, "MKCOL", "/webdav/a")).status).toBe(201)
    expect((await dav(pat, "MKCOL", "/webdav/a/c")).status).toBe(201)

    // The destination does not exist yet, which is exactly the case the old
    // check skipped: it compared against the destination's own id.
    const cycle = await dav(pat, "MOVE", "/webdav/a", { headers: { destination: "http://test.local/webdav/a/c/a" } })
    expect(cycle.status).toBe(409)
    const self = await dav(pat, "MOVE", "/webdav/a", { headers: { destination: "http://test.local/webdav/a/a" } })
    expect(self.status).toBe(409)

    const a = await db.one(from("folders").where(q => q("name").equals("a")).select("id", "parent_id")) as { id: number; parent_id: number | null }
    expect(a.parent_id).toBeNull()

    // A rename and a real move still work.
    expect((await dav(pat, "MKCOL", "/webdav/b")).status).toBe(201)
    const moved = await dav(pat, "MOVE", "/webdav/a", { headers: { destination: "http://test.local/webdav/b/renamed" } })
    expect(moved.status).toBe(201)
    const list = await dav(pat, "PROPFIND", "/webdav/b/", { headers: { depth: "1" } })
    expect(list.text).toContain("renamed")
  })

  test("MOVE and COPY need the destination's parent collection to exist", async () => {
    const { pat } = await setup()
    await dav(pat, "PUT", "/webdav/f.txt", { body: "x" })
    const move = await dav(pat, "MOVE", "/webdav/f.txt", { headers: { destination: "http://test.local/webdav/nope/deeper/f.txt" } })
    expect(move.status).toBe(409)
    const copy = await dav(pat, "COPY", "/webdav/f.txt", { headers: { destination: "http://test.local/webdav/nope/f.txt" } })
    expect(copy.status).toBe(409)
    // Still exactly where it was.
    expect((await dav(pat, "GET", "/webdav/f.txt")).status).toBe(200)
  })

  test("PUT and COPY are held to the storage quota", async () => {
    const { pat, userId } = await setup()
    await db.execute(from("users").where(q => q("id").equals(userId)).update({ storage_quota_bytes: 10 }))
    const ok = await dav(pat, "PUT", "/webdav/six.txt", { body: "123456" })
    expect(ok.status).toBe(201)
    const over = await dav(pat, "PUT", "/webdav/more.txt", { body: "1234567" })
    expect(over.status).toBe(507)
    const copy = await dav(pat, "COPY", "/webdav/six.txt", { headers: { destination: "http://test.local/webdav/six2.txt" } })
    expect(copy.status).toBe(507)
    expect((await dav(pat, "GET", "/webdav/more.txt")).status).toBe(404)
  })

  test("replacing a file resets its scan verdict; an infected file is not served", async () => {
    const { pat } = await setup()
    await dav(pat, "PUT", "/webdav/v.txt", { body: "first" })
    await db.execute(from("files").where(q => q("name").equals("v.txt")).update({ scan_status: "infected", scan_signature: "Eicar-Test" }))
    expect((await dav(pat, "GET", "/webdav/v.txt")).status).toBe(403)

    const put = await dav(pat, "PUT", "/webdav/v.txt", { body: "second" })
    expect(put.status).toBe(204)
    const row = await db.one(from("files").where(q => q("name").equals("v.txt")).select("scan_status", "scan_signature", "version")) as any
    // No clamd in tests, so the fresh verdict is 'skipped'.
    expect(row.scan_status).toBe("skipped")
    expect(row.scan_signature).toBeNull()
    expect(row.version).toBe(2)
    expect((await dav(pat, "GET", "/webdav/v.txt")).text).toBe("second")
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

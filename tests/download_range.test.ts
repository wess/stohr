import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson, callRaw, fakeStore } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const CONTENT = "0123456789abcdefghijklmnopqrstuvwxyz"

const signupOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  return res.body as { id: number; token: string }
}

// Upload through the real handler so storage_key, size and mime all line up
// with what a download will look for.
const uploadFile = async (token: string, name: string, body: string) => {
  const form = new FormData()
  form.append("file", new Blob([body], { type: "text/plain" }), name)
  const req = new Request("http://test.local/files", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "127.0.0.1" },
    body: form,
  })
  const res = await app(req)
  const parsed = await res.json()
  return (Array.isArray(parsed) ? parsed[0] : parsed) as { id: number }
}

describe("GET /files/:id/download — range requests", () => {
  test("a plain download advertises range support", async () => {
    const u = await signupOwner()
    const f = await uploadFile(u.token, "a.txt", CONTENT)

    const res = await callRaw(app, `/files/${f.id}/download`, {
      headers: { authorization: `Bearer ${u.token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("content-length")).toBe(String(CONTENT.length))
    expect(res.text).toBe(CONTENT)
  })

  test("an explicit range returns 206 with only those bytes", async () => {
    const u = await signupOwner()
    const f = await uploadFile(u.token, "b.txt", CONTENT)

    const res = await callRaw(app, `/files/${f.id}/download`, {
      headers: { authorization: `Bearer ${u.token}`, range: "bytes=0-9" },
    })
    expect(res.status).toBe(206)
    expect(res.text).toBe("0123456789")
    expect(res.headers.get("content-range")).toBe(`bytes 0-9/${CONTENT.length}`)
    expect(res.headers.get("content-length")).toBe("10")
  })

  test("an open-ended range runs to the last byte", async () => {
    const u = await signupOwner()
    const f = await uploadFile(u.token, "c.txt", CONTENT)

    const res = await callRaw(app, `/files/${f.id}/download`, {
      headers: { authorization: `Bearer ${u.token}`, range: "bytes=26-" },
    })
    expect(res.status).toBe(206)
    expect(res.text).toBe("qrstuvwxyz")
    expect(res.headers.get("content-range")).toBe(`bytes 26-35/${CONTENT.length}`)
  })

  test("Safari's opening probe is answered with 206", async () => {
    const u = await signupOwner()
    const f = await uploadFile(u.token, "d.txt", CONTENT)

    const res = await callRaw(app, `/files/${f.id}/download`, {
      headers: { authorization: `Bearer ${u.token}`, range: "bytes=0-1" },
    })
    expect(res.status).toBe(206)
    expect(res.text).toBe("01")
  })

  test("a range past the end is rejected with 416", async () => {
    const u = await signupOwner()
    const f = await uploadFile(u.token, "e.txt", CONTENT)

    const res = await callRaw(app, `/files/${f.id}/download`, {
      headers: { authorization: `Bearer ${u.token}`, range: "bytes=9999-" },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe(`bytes */${CONTENT.length}`)
  })

  test("an unparseable range header falls back to the whole object", async () => {
    const u = await signupOwner()
    const f = await uploadFile(u.token, "f.txt", CONTENT)

    const res = await callRaw(app, `/files/${f.id}/download`, {
      headers: { authorization: `Bearer ${u.token}`, range: "bytes=0-99,200-299" },
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe(CONTENT)
  })
})

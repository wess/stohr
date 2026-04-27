import { describe, expect, test } from "bun:test"
import { createClient, StohrError } from "../src/index.ts"

type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: string }

const mockFetch = (responses: Array<{ status?: number; body: unknown; expect?: (call: FetchCall) => void }>) => {
  const calls: FetchCall[] = []
  let i = 0
  const fn = async (url: RequestInfo | URL, init?: RequestInit) => {
    const reqInit = (init ?? {}) as RequestInit
    const headers: Record<string, string> = {}
    const rawHeaders = reqInit.headers
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => { headers[k] = v })
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v as string
      }
    }
    const call: FetchCall = {
      url: typeof url === "string" ? url : url.toString(),
      method: reqInit.method ?? "GET",
      headers,
      body: typeof reqInit.body === "string" ? reqInit.body : undefined,
    }
    calls.push(call)
    const next = responses[i++]
    if (!next) throw new Error("No more mock responses")
    next.expect?.(call)
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
    })
  }
  return { fn, calls }
}

describe("auth", () => {
  test("login stores token", async () => {
    const { fn } = mockFetch([{ body: { id: 1, email: "a@b.com", username: "alice", name: "Alice", is_owner: false, created_at: "now", token: "tkn-123" } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn })
    const res = await c.auth.login("alice", "secret")
    expect(res.token).toBe("tkn-123")
    expect(c.getToken()).toBe("tkn-123")
  })

  test("signup with invite", async () => {
    const { fn, calls } = mockFetch([{ body: { id: 1, email: "a@b.com", username: "alice", name: "Alice", is_owner: false, created_at: "now", token: "tkn" } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn })
    await c.auth.signup({ name: "A", username: "alice", email: "a@b.com", password: "longenough", inviteToken: "inv1" })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.invite_token).toBe("inv1")
    expect(body.username).toBe("alice")
  })

  test("error response throws StohrError", async () => {
    const { fn } = mockFetch([{ status: 401, body: { error: "Invalid credentials" } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn })
    await expect(c.auth.login("x", "y")).rejects.toBeInstanceOf(StohrError)
  })
})

describe("folders", () => {
  test("list with no parent", async () => {
    const { fn, calls } = mockFetch([{ body: [{ id: 1, name: "Photos", parent_id: null, created_at: "n" }] }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    const folders = await c.folders.list(null)
    expect(folders).toHaveLength(1)
    expect(calls[0]!.url).toContain("parent_id=null")
    expect(calls[0]!.headers.authorization).toBe("Bearer t")
  })

  test("create photos folder", async () => {
    const { fn, calls } = mockFetch([{ body: { id: 7, name: "Italy", parent_id: null, kind: "photos", is_public: false, created_at: "n" } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    const f = await c.folders.create("Italy", null, { kind: "photos", isPublic: true })
    expect(f.id).toBe(7)
    const body = JSON.parse(calls[0]!.body!)
    expect(body).toEqual({ name: "Italy", parent_id: null, kind: "photos", is_public: true })
  })
})

describe("files", () => {
  test("upload posts multipart with correct fields", async () => {
    const { fn, calls } = mockFetch([{ body: [{ id: 1, name: "a.txt", mime: "text/plain", size: 5, folder_id: null, version: 1, created_at: "n" }] }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    const result = await c.files.upload({ file: new Blob(["hello"]), name: "a.txt", folderId: 5 })
    expect(result[0]!.id).toBe(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url).toBe("https://test.local/api/files")
  })

  test("download returns bytes", async () => {
    const { fn } = mockFetch([{ body: "hello world" }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    const bytes = await c.files.download(42)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(bytes)).toBe("hello world")
  })

  test("thumbnail returns null on 404", async () => {
    const { fn } = mockFetch([{ status: 404, body: { error: "No thumbnail" } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    const thumb = await c.files.thumbnail(42)
    expect(thumb).toBeNull()
  })
})

describe("shares + collaborators", () => {
  test("create share with expiry", async () => {
    const { fn, calls } = mockFetch([{ body: { id: 1, token: "abc", expires_at: null, created_at: "n", name: "f", size: 1, mime: "x", file_id: 1 } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    await c.shares.create(1, 3600)
    const body = JSON.parse(calls[0]!.body!)
    expect(body.expires_in).toBe(3600)
  })

  test("add folder collaborator", async () => {
    const { fn, calls } = mockFetch([{ body: { id: 1, user_id: 2, email: null, role: "editor", created_at: "n", accepted_at: "n", user: null } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    await c.collaborators.add("folder", 5, "alice", "editor")
    expect(calls[0]!.url).toBe("https://test.local/api/folders/5/collaborators")
    expect(JSON.parse(calls[0]!.body!)).toEqual({ identity: "alice", role: "editor" })
  })
})

describe("subscription + s3 keys", () => {
  test("subscription returns usage", async () => {
    const { fn } = mockFetch([{ body: { tier: "pro", quota_bytes: 268435456000, used_bytes: 1024, status: "active", renews_at: "n", has_subscription: true } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    const sub = await c.me.subscription()
    expect(sub.tier).toBe("pro")
  })

  test("create s3 key returns secret", async () => {
    const { fn } = mockFetch([{ body: { id: 1, access_key: "AKIA…", secret_key: "shhh", name: "ci", created_at: "n", last_used_at: null } }])
    const c = createClient({ baseUrl: "https://test.local/api", fetch: fn, token: "t" })
    const key = await c.s3Keys.create("ci")
    expect(key.secret_key).toBe("shhh")
  })
})

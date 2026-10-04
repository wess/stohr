import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { computeSignature, sha256OfBytes } from "../src/s3/sigv4.ts"
import { finalizeUpload } from "../src/uploads/finalize.ts"
import type { App } from "./helpers/http.ts"
import { callJson, callRaw, fakeStore, makeRequest } from "./helpers/http.ts"
import { callMultipart } from "./helpers/multipart.ts"
import { buildProtocolApp } from "./helpers/protocolapp.ts"
import { ROOT, type Session, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

// The team cap is enforced on every upload path, before the write and again
// after it: the pre-check races with every other write, so the row goes in,
// usage is re-read, and an overflow is undone — row and blob both.

// chunk staging only goes through the StorageHandle under the local driver
process.env.STORAGE_DRIVER = "local"

let app: App

beforeAll(() => {
  app = buildProtocolApp(db, TEST_SECRET)
})
beforeEach(async () => {
  await truncateAll()
})

const settings = (owner: Session, body: Record<string, boolean>) =>
  callJson(app, "/admin/settings", { method: "PATCH", host: ROOT, token: owner.token, body })

const setTeamQuota = async (owner: Session, teamId: number, quota: number) => {
  const res = await callJson(app, `/admin/teams/${teamId}`, {
    method: "PATCH",
    host: ROOT,
    token: owner.token,
    body: { quota_bytes: quota },
  })
  expect(res.status).toBe(200)
}

const filesOf = (userId: number) =>
  db.all(
    from("files")
      .where(q => q("user_id").equals(userId))
      .select("id", "name", "storage_key"),
  ) as Promise<Array<{ id: number; name: string; storage_key: string }>>

const bytes = (n: number) => "x".repeat(n)

describe("chunked upload finalize", () => {
  test("a session that fit at init is rolled back when the team is over cap at finalize", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme", { quota_bytes: 100 })
    const init = await callJson(app, "/files/upload/init", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { file_name: "big.txt", total_size: 60, mime: "text/plain" },
    })
    expect(init.status).toBe(201)
    const id = init.body.id as string

    // the cap shrinks under the open session, as another member's upload would
    await setTeamQuota(owner, a.created.team.id, 30)

    const chunk = await callRaw(app, `/files/upload/${id}/chunk`, {
      method: "POST",
      host: a.host,
      body: bytes(60),
      headers: { authorization: `Bearer ${a.admin.token}`, "content-type": "application/octet-stream" },
    })
    expect(chunk.status).toBe(200)
    const session = (await db.one(
      from("upload_sessions")
        .where(q => q("id").equals(id))
        .select("storage_key"),
    )) as { storage_key: string }

    const fin = await callJson(app, `/files/upload/${id}/finalize`, { method: "POST", host: a.host, token: a.admin.token })
    expect(fin.status).toBe(402)
    expect(fin.body.scope).toBe("team")
    expect(fin.body.error).toBe("Team storage quota exceeded")
    expect(fin.body.quota_bytes).toBe(30)

    expect(await filesOf(a.created.admin.id)).toHaveLength(0)
    expect((await fakeStore.get(session.storage_key)).status).toBe(404)
    // the session is gone either way
    expect(await db.one(from("upload_sessions").where(q => q("id").equals(id)))).toBeNull()
  })

  test("finalizeUpload itself undoes the row and blob on a team overflow", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme", { quota_bytes: 100 })
    const first = await callMultipart(app, "/files", {
      token: a.admin.token,
      host: a.host,
      files: [{ name: "first.txt", type: "text/plain", body: bytes(60) }],
    })
    expect(first.status).toBe(201)
    await setTeamQuota(owner, a.created.team.id, 50)

    // an assembled object already in storage, as finalize sees it
    const key = `u${a.created.admin.id}/late/late.txt`
    await fakeStore.put(key, bytes(10), "text/plain")
    const result = await finalizeUpload(db, fakeStore, {
      ownerId: a.created.admin.id,
      folderId: null,
      name: "late.txt",
      mime: "text/plain",
      size: 10,
      key,
      thumbBytes: null,
      quotaBytes: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.scope).toBe("team")
      expect(result.quota_bytes).toBe(50)
      expect(result.used_bytes).toBe(70)
    }
    const rows = await filesOf(a.created.admin.id)
    expect(rows.map(r => r.name)).toEqual(["first.txt"])
    expect((await fakeStore.get(key)).status).toBe(404)
  })
})

describe("webdav put and copy", () => {
  const dav = (host: string, email: string, pat: string, method: string, path: string, body?: string, extra = {}) =>
    callRaw(app, path, {
      method,
      host,
      body,
      basic: { user: email, pass: pat },
      headers: { "content-type": "text/plain", ...extra },
    })

  test("the team cap answers 507 with scope team and leaves nothing behind", async () => {
    const owner = await signupOwner(app)
    await settings(owner, { webdav_enabled: true })
    const a = await teamWithAdmin(app, owner, "acme", { quota_bytes: 100 })
    const pat = (await callJson(app, "/me/apps", { method: "POST", host: a.host, token: a.admin.token, body: { name: "dav" } }))
      .body.token as string
    const email = a.created.admin.email

    const tooBig = await dav(a.host, email, pat, "PUT", "/webdav/huge.txt", bytes(150))
    expect(tooBig.status).toBe(507)
    expect(JSON.parse(tooBig.text).scope).toBe("team")
    expect(await filesOf(a.created.admin.id)).toHaveLength(0)

    expect((await dav(a.host, email, pat, "PUT", "/webdav/a.txt", bytes(60))).status).toBe(201)
    const second = await dav(a.host, email, pat, "PUT", "/webdav/b.txt", bytes(60))
    expect(second.status).toBe(507)
    expect(JSON.parse(second.text).scope).toBe("team")

    // a copy is a second full object and counts the same way
    const copy = await dav(a.host, email, pat, "COPY", "/webdav/a.txt", undefined, {
      destination: `http://${a.host}/webdav/a-copy.txt`,
    })
    expect(copy.status).toBe(507)
    expect(JSON.parse(copy.text).scope).toBe("team")

    const rows = await filesOf(a.created.admin.id)
    expect(rows.map(r => r.name)).toEqual(["a.txt"])
  })
})

describe("s3 put", () => {
  const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const s3Put = async (host: string, creds: { accessKey: string; secretKey: string }, path: string, body: string) => {
    const bodyBytes = new TextEncoder().encode(body)
    const date = amzDate(Date.now())
    const credDate = date.slice(0, 8)
    const payloadHash = sha256OfBytes(bodyBytes)
    const headers: Record<string, string> = { "x-amz-date": date, "x-amz-content-sha256": payloadHash }
    const scope = `${credDate}/us-east-1/s3/aws4_request`
    const signature = computeSignature({
      method: "PUT",
      path,
      query: "",
      headers,
      payloadHash,
      secretKey: creds.secretKey,
      amzDate: date,
      sig: {
        accessKey: creds.accessKey,
        date: credDate,
        region: "us-east-1",
        service: "s3",
        scope,
        signedHeaders: ["x-amz-content-sha256", "x-amz-date"],
        signature: "",
      },
    })
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=x-amz-content-sha256;x-amz-date, Signature=${signature}`
    headers["content-type"] = "text/plain"
    const res = await app(makeRequest(path, { method: "PUT", headers, body: bodyBytes, host }))
    return { status: res.status, text: await res.text() }
  }

  test("the team cap answers EntityTooLarge and leaves nothing behind", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme", { quota_bytes: 100 })
    const key = await callJson(app, "/me/s3-keys", { method: "POST", host: a.host, token: a.admin.token, body: { name: "k" } })
    const creds = { accessKey: key.body.access_key as string, secretKey: key.body.secret_key as string }
    const bucket = a.created.admin.username

    expect((await s3Put(a.host, creds, `/s3/${bucket}/a.txt`, bytes(60))).status).toBe(200)
    const over = await s3Put(a.host, creds, `/s3/${bucket}/b.txt`, bytes(60))
    expect(over.status).toBe(413)
    expect(over.text).toContain("EntityTooLarge")
    expect(over.text).toContain("Team storage quota exceeded")
    const rows = await filesOf(a.created.admin.id)
    expect(rows.map(r => r.name)).toEqual(["a.txt"])
  })
})

describe("photo backup", () => {
  test("the team cap answers 402 with scope team and leaves nothing behind", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme", { quota_bytes: 100 })
    const ok = await callMultipart(app, "/photos/upload", {
      token: a.admin.token,
      host: a.host,
      fields: { asset_id: "asset-1", mime: "text/plain" },
      files: [{ name: "one.txt", type: "text/plain", body: bytes(60) }],
    })
    expect(ok.status).toBe(201)

    const over = await callMultipart(app, "/photos/upload", {
      token: a.admin.token,
      host: a.host,
      fields: { asset_id: "asset-2", mime: "text/plain" },
      files: [{ name: "two.txt", type: "text/plain", body: bytes(60) }],
    })
    expect(over.status).toBe(402)
    expect(over.body.scope).toBe("team")
    expect(over.body.error).toBe("Team storage quota exceeded")
    const rows = await filesOf(a.created.admin.id)
    expect(rows.map(r => r.name)).toEqual(["one.txt"])
  })
})

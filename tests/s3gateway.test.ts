import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { s3Routes } from "../src/s3/index.ts"
import { computeSignature, sha256OfBytes } from "../src/s3/sigv4.ts"
import { s3KeyRoutes } from "../src/s3keys/index.ts"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { callJson, fakeStore } from "./helpers/http.ts"

let app: ReturnType<typeof router>

beforeAll(() => {
  app = router(...authRoutes(db, TEST_SECRET), ...s3KeyRoutes(db, TEST_SECRET), ...s3Routes(db, fakeStore))
})
beforeEach(async () => { await truncateAll() })

const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")

const setup = async () => {
  const signup = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@x.test", password: "password123" },
  })
  const key = await callJson(app, "/me/s3-keys", { method: "POST", token: signup.body.token, body: { name: "test" } })
  return { accessKey: key.body.access_key as string, secretKey: key.body.secret_key as string, userId: signup.body.id as number }
}

// Signs the way an SDK would, minus the host header (Request rewrites it).
// `signedAt` and `credDate` are separable so each check can be driven alone.
const s3 = async (
  creds: { accessKey: string; secretKey: string },
  method: string,
  path: string,
  opts: { body?: string; signedAt?: number; credDate?: string; declaredHash?: string } = {},
) => {
  const bodyBytes = opts.body === undefined ? null : new TextEncoder().encode(opts.body)
  const date = amzDate(opts.signedAt ?? Date.now())
  const credDate = opts.credDate ?? date.slice(0, 8)
  const payloadHash = opts.declaredHash ?? (bodyBytes ? sha256OfBytes(bodyBytes) : "UNSIGNED-PAYLOAD")
  const headers: Record<string, string> = { "x-amz-date": date, "x-amz-content-sha256": payloadHash }
  const scope = `${credDate}/us-east-1/s3/aws4_request`
  const signature = computeSignature({
    method, path, query: "", headers, payloadHash, secretKey: creds.secretKey, amzDate: date,
    sig: {
      accessKey: creds.accessKey, date: credDate, region: "us-east-1", service: "s3", scope,
      signedHeaders: ["x-amz-content-sha256", "x-amz-date"], signature: "",
    },
  })
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=x-amz-content-sha256;x-amz-date, Signature=${signature}`
  if (bodyBytes) headers["content-type"] = "text/plain"
  const res = await app(new Request(`http://test.local${path}`, { method, headers, body: bodyBytes }))
  return { status: res.status, text: await res.text() }
}

describe("s3 gateway signatures", () => {
  test("a correctly signed PUT then GET round-trips", async () => {
    const creds = await setup()
    const put = await s3(creds, "PUT", "/s3/owner/docs/hello.txt", { body: "hello s3" })
    expect(put.status).toBe(200)
    const get = await s3(creds, "GET", "/s3/owner/docs/hello.txt")
    expect(get.status).toBe(200)
    expect(get.text).toBe("hello s3")
  })

  test("a request signed more than 15 minutes ago is refused", async () => {
    const creds = await setup()
    const stale = await s3(creds, "GET", "/s3/owner/x.txt", { signedAt: Date.now() - 20 * 60 * 1000 })
    expect(stale.status).toBe(403)
    expect(stale.text).toContain("RequestTimeTooSkewed")
    const future = await s3(creds, "GET", "/s3/owner/x.txt", { signedAt: Date.now() + 20 * 60 * 1000 })
    expect(future.status).toBe(403)
  })

  test("the credential scope date must match x-amz-date", async () => {
    const creds = await setup()
    const yesterday = amzDate(Date.now() - 86400_000).slice(0, 8)
    const r = await s3(creds, "GET", "/s3/owner/x.txt", { credDate: yesterday })
    expect(r.status).toBe(403)
    expect(r.text).toContain("SignatureDoesNotMatch")
  })

  test("a body that does not match its declared hash is refused and not stored", async () => {
    const creds = await setup()
    const wrong = sha256OfBytes(new TextEncoder().encode("something else"))
    const r = await s3(creds, "PUT", "/s3/owner/tampered.txt", { body: "real body", declaredHash: wrong })
    expect(r.status).toBe(400)
    expect(r.text).toContain("XAmzContentSHA256Mismatch")
    expect(await db.one(from("files").where(q => q("name").equals("tampered.txt")).select("id"))).toBeNull()
  })

  test("an infected object is not served, and a PUT over it resets the verdict", async () => {
    const creds = await setup()
    await s3(creds, "PUT", "/s3/owner/v.txt", { body: "v1" })
    await db.execute(from("files").where(q => q("name").equals("v.txt")).update({ scan_status: "infected" }))
    expect((await s3(creds, "GET", "/s3/owner/v.txt")).status).toBe(403)
    expect((await s3(creds, "PUT", "/s3/owner/v.txt", { body: "v2" })).status).toBe(200)
    const row = await db.one(from("files").where(q => q("name").equals("v.txt")).select("scan_status", "version")) as any
    expect(row.scan_status).toBe("skipped")
    expect(row.version).toBe(2)
    expect((await s3(creds, "GET", "/s3/owner/v.txt")).text).toBe("v2")
  })

  test("a PUT that overflows the quota after the write is rolled back", async () => {
    const creds = await setup()
    await db.execute(from("users").where(q => q("id").equals(creds.userId)).update({ storage_quota_bytes: 10 }))
    expect((await s3(creds, "PUT", "/s3/owner/a.txt", { body: "12345" })).status).toBe(200)
    const over = await s3(creds, "PUT", "/s3/owner/b.txt", { body: "1234567" })
    expect(over.status).toBe(413)
    expect(await db.one(from("files").where(q => q("name").equals("b.txt")).select("id"))).toBeNull()
  })
})

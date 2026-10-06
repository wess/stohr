import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { headersFromRequest, s3Routes } from "../src/s3/index.ts"
import { canonicalPath, canonicalQuery, computeSignature, parseAmzDate, parseAuthHeader, sha256OfBytes } from "../src/s3/sigv4.ts"
import { parseTrustedProxies } from "../src/security/proxies.ts"
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

// SDK signatures bind the original public Host.
// `signedAt` and `credDate` are separable so each check can be driven alone.
const s3 = async (
  creds: { accessKey: string; secretKey: string },
  method: string,
  path: string,
  opts: { body?: string; signedAt?: number; credDate?: string; declaredHash?: string; requestHost?: string } = {},
) => {
  const bodyBytes = opts.body === undefined ? null : new TextEncoder().encode(opts.body)
  const date = amzDate(opts.signedAt ?? Date.now())
  const credDate = opts.credDate ?? date.slice(0, 8)
  const payloadHash = opts.declaredHash ?? (bodyBytes ? sha256OfBytes(bodyBytes) : "UNSIGNED-PAYLOAD")
  const headers: Record<string, string> = { host: "test.local", "x-amz-date": date, "x-amz-content-sha256": payloadHash }
  const scope = `${credDate}/us-east-1/s3/aws4_request`
  const signature = computeSignature({
    method, path, query: "", headers, payloadHash, secretKey: creds.secretKey, amzDate: date,
    sig: {
      accessKey: creds.accessKey, date: credDate, region: "us-east-1", service: "s3", scope,
      signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"], signature: "",
    },
  })
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
  if (bodyBytes) headers["content-type"] = "text/plain"
  if (opts.requestHost) headers.host = opts.requestHost
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


test("forwarded signing Host is honored only from trusted sockets", () => {
  const req = new Request("http://api.internal:3000/s3/owner/x", { headers: { host: "api.internal:3000", "x-forwarded-host": "files.example:443" } }) as Request & { peerIp?: string }
  const trusted = parseTrustedProxies("127.0.0.1")
  req.peerIp = "198.51.100.8"
  expect(headersFromRequest(req, trusted).host).toBe("api.internal:3000")
  req.peerIp = "127.0.0.1"
  expect(headersFromRequest(req, trusted).host).toBe("files.example:443")
  req.headers.set("x-forwarded-host", "evil.test,files.example")
  expect(headersFromRequest(req, trusted).host).toBe("api.internal:3000")
})

test("SigV4 rejects unsigned clock/host, malformed scope and ambiguous headers", () => {
  const signature = "a".repeat(64)
  const auth = (scope = "20261005/us-east-1/s3/aws4_request", signed = "host;x-amz-date", sig = signature) => `AWS4-HMAC-SHA256 Credential=key/${scope}, SignedHeaders=${signed}, Signature=${sig}`
  expect(parseAuthHeader(auth())).not.toBeNull()
  for (const signed of ["x-amz-date", "host", "host;host;x-amz-date", "x-amz-date;host", "Host;x-amz-date"]) expect(parseAuthHeader(auth(undefined, signed))).toBeNull()
  for (const scope of ["wrong/us-east-1/s3/aws4_request", "20261005/us-east-1/ec2/aws4_request", "20261005/us-east-1/s3/other"]) expect(parseAuthHeader(auth(scope))).toBeNull()
  expect(parseAuthHeader(auth(undefined, undefined, "z".repeat(64)))).toBeNull()
})

test("suspended and soft-deleted users cannot use existing S3 access keys", async () => {
  const creds = await setup()
  expect((await s3(creds, "PUT", "/s3/owner/live.txt", { body: "live" })).status).toBe(200)
  await db.execute(from("users").where(q => q("id").equals(creds.userId)).update({ suspended_at: new Date() }))
  expect((await s3(creds, "GET", "/s3/owner/live.txt")).status).toBe(403)
  await db.execute(from("users").where(q => q("id").equals(creds.userId)).update({ suspended_at: null, deleted_at: new Date() }))
  expect((await s3(creds, "GET", "/s3/owner/live.txt")).status).toBe(403)
})


test("changing a signed Host invalidates the signature", async () => {
  const creds = await setup()
  const res = await s3(creds, "PUT", "/s3/owner/host.txt", { body: "secret", requestHost: "attacker.example" })
  expect(res.status).toBe(403)
  expect(res.text).toContain("SignatureDoesNotMatch")
  expect(await db.one(from("files").where(q => q("name").equals("host.txt")))).toBeNull()
})


test("S3 canonical paths preserve single encoding and reject invalid clocks", () => {
  expect(canonicalPath("/s3/owner/hello%20world.txt")).toBe("/s3/owner/hello%20world.txt")
  expect(canonicalPath("/s3/owner/caf%C3%A9%25.txt")).toBe("/s3/owner/caf%C3%A9%25.txt")
  expect(canonicalPath("/s3/owner/a%2fb.txt")).toBe("/s3/owner/a%2Fb.txt")
  expect(parseAmzDate("20261301T010203Z")).toBeNull()
  expect(parseAmzDate("20260231T010203Z")).toBeNull()
})

test("encoded object filenames round-trip through S3 signing", async () => {
  const creds = await setup()
  const path = "/s3/owner/caf%C3%A9%20notes%25.txt"
  expect((await s3(creds, "PUT", path, { body: "encoded" })).status).toBe(200)
  const res = await s3(creds, "GET", path)
  expect(res.status).toBe(200)
  expect(res.text).toBe("encoded")
})


test("AWS published signatures match independently supplied vectors", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  const date = "20130524T000000Z"
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  const base = { query: "", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", amzDate: date }
  const scope = "20130524/us-east-1/s3/aws4_request"
  const sig = { accessKey: "AKIAIOSFODNN7EXAMPLE", date: "20130524", region: "us-east-1", service: "s3", scope, signature: "" }
  expect(computeSignature({ ...base, method: "GET", path: "/test.txt", payloadHash: emptyHash,
    headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": emptyHash, "x-amz-date": date },
    sig: { ...sig, signedHeaders: ["host", "range", "x-amz-content-sha256", "x-amz-date"] },
  })).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")
  const hash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
  expect(computeSignature({ ...base, method: "PUT", path: "/test%24file.text", payloadHash: hash,
    headers: { host: "examplebucket.s3.amazonaws.com", date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-content-sha256": hash, "x-amz-date": date, "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    sig: { ...sig, signedHeaders: ["date", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-storage-class"] },
  })).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd")
  expect(canonicalQuery("?a=lower&Z=upper&a=Z&a=a")).toBe("Z=upper&a=Z&a=a&a=lower")
  expect(computeSignature({ ...base, method: "GET", path: "/", query: "?prefix=J&max-keys=2", payloadHash: emptyHash,
    headers: { host: "examplebucket.s3.amazonaws.com", "x-amz-content-sha256": emptyHash, "x-amz-date": date },
    sig: { ...sig, signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"] },
  })).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7")
  expect(canonicalPath("/s3/owner/😀.txt")).toBe("/s3/owner/%F0%9F%98%80.txt")
})

test("configured malware scanning blocks all unfinished S3 verdicts", async () => {
  const previous = process.env.CLAMD_HOST
  process.env.CLAMD_HOST = "127.0.0.1"
  try {
    const creds = await setup()
    expect((await s3(creds, "PUT", "/s3/owner/scanning.txt", { body: "bytes" })).status).toBe(200)
    for (const scanStatus of ["pending", "error", "skipped", "infected"]) {
      await db.execute(from("files").where(q => q("name").equals("scanning.txt")).update({ scan_status: scanStatus }))
      expect((await s3(creds, "GET", "/s3/owner/scanning.txt")).status).toBe(403)
    }
    await db.execute(from("files").where(q => q("name").equals("scanning.txt")).update({ scan_status: "clean" }))
    expect((await s3(creds, "GET", "/s3/owner/scanning.txt")).status).toBe(200)
  } finally {
    if (previous === undefined) delete process.env.CLAMD_HOST
    else process.env.CLAMD_HOST = previous
  }
})

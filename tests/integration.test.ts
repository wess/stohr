import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { clamdConfig } from "../src/scanning/index.ts"
import { CHUNK_SIZE } from "../src/uploads/config.ts"
import { buildBody, sign, WEBHOOK_EVENTS } from "../src/webhooks/dispatch.ts"

describe("webhook signing", () => {
  test("sign produces the github-style sha256= hmac over the body", () => {
    const body = JSON.stringify({ event: "file.created", file_id: 7 })
    const expected = `sha256=${createHmac("sha256", "topsecret").update(body).digest("hex")}`
    expect(sign("topsecret", body)).toBe(expected)
  })

  test("buildBody returns raw JSON for application/json", () => {
    const payload = { a: 1, b: "two" }
    expect(buildBody("application/json", payload)).toBe(JSON.stringify(payload))
  })

  test("buildBody wraps JSON in a payload= form field for urlencoded", () => {
    const payload = { event: "share.created" }
    const out = buildBody("application/x-www-form-urlencoded", payload)
    expect(out.startsWith("payload=")).toBe(true)
    expect(JSON.parse(new URLSearchParams(out).get("payload") ?? "{}")).toEqual(payload)
  })

  test("the 1.0 event set is exactly the four documented events", () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      ["collaboration.invited", "file.created", "file.deleted", "share.created"].sort(),
    )
  })
})

describe("upload session math", () => {
  test("chunk size is the S3 multipart minimum of 5MB", () => {
    expect(CHUNK_SIZE).toBe(5 * 1024 * 1024)
  })

  test("chunks_expected = ceil(total / CHUNK_SIZE)", () => {
    const chunksExpected = (total: number) => Math.max(1, Math.ceil(total / CHUNK_SIZE))
    expect(chunksExpected(0)).toBe(1)
    expect(chunksExpected(CHUNK_SIZE)).toBe(1)
    expect(chunksExpected(CHUNK_SIZE + 1)).toBe(2)
    expect(chunksExpected(CHUNK_SIZE * 3)).toBe(3)
    expect(chunksExpected(CHUNK_SIZE * 3 + 7)).toBe(4)
  })
})

describe("clamd config gating", () => {
  test("returns null when CLAMD_HOST is unset", () => {
    const prev = process.env.CLAMD_HOST
    delete process.env.CLAMD_HOST
    expect(clamdConfig()).toBeNull()
    if (prev !== undefined) process.env.CLAMD_HOST = prev
  })

  test("returns host/port when CLAMD_HOST is set", () => {
    const prevHost = process.env.CLAMD_HOST
    const prevPort = process.env.CLAMD_PORT
    process.env.CLAMD_HOST = "clamav"
    process.env.CLAMD_PORT = "3310"
    expect(clamdConfig()).toEqual({ host: "clamav", port: 3310 })
    if (prevHost === undefined) delete process.env.CLAMD_HOST
    else process.env.CLAMD_HOST = prevHost
    if (prevPort === undefined) delete process.env.CLAMD_PORT
    else process.env.CLAMD_PORT = prevPort
  })
})

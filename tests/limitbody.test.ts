import { describe, expect, test } from "bun:test"
import { get, json, parseJson, pipeline, post, router } from "@atlas/server"
import { limitBody } from "../src/util/limitbody/index.ts"

const LIMIT = 64

const app = router(
  post(
    "/echo",
    pipeline(limitBody(LIMIT), parseJson)(async c => json(c, 200, { got: c.body })),
  ),
  get(
    "/ping",
    pipeline(limitBody(LIMIT))(async c => json(c, 200, { ok: true })),
  ),
)

const postJson = (body: BodyInit, extra: Record<string, string> = {}) =>
  app(
    new Request("http://test.local/echo", {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body,
      // required by the fetch spec for a streaming body
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
  )

const streamOf = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const p of parts) ctrl.enqueue(new TextEncoder().encode(p))
      ctrl.close()
    },
  })

describe("limitBody", () => {
  test("small bodies pass through intact to parseJson", async () => {
    const res = await postJson(JSON.stringify({ a: 1, b: "two" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: { a: 1, b: "two" } })
  })

  test("a declared content-length over the cap is refused without reading", async () => {
    const big = JSON.stringify({ pad: "x".repeat(LIMIT * 4) })
    const res = await postJson(big)
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/exceeds 64 bytes/)
  })

  test("a chunked body with no content-length is cut off once it crosses the cap", async () => {
    const chunk = `"${"y".repeat(40)}"`
    const req = new Request("http://test.local/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamOf("[", chunk, ",", chunk, "]"),
      duplex: "half",
    } as RequestInit)
    expect(req.headers.get("content-length")).toBeNull()
    const res = await app(req)
    expect(res.status).toBe(413)
  })

  test("a chunked body under the cap is reassembled for the parser", async () => {
    const req = new Request("http://test.local/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamOf('{"a":', "1", "}"),
      duplex: "half",
    } as RequestInit)
    const res = await app(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: { a: 1 } })
  })

  test("bodiless requests are untouched", async () => {
    const res = await app(new Request("http://test.local/ping"))
    expect(res.status).toBe(200)
  })

  // withSecurityHeaders and withTeams stash state on the Request object; the
  // rebuilt request has to keep it or clientIp()/teamFor() go blind on every
  // route with a body
  test("expando props on the request survive the rebuild", async () => {
    const seen: Record<string, unknown> = {}
    const probe = router(
      post(
        "/probe",
        pipeline(limitBody(LIMIT), parseJson)(async c => {
          seen.peerIp = (c.request as { peerIp?: string }).peerIp
          seen.stash = (c.request as { stohrTeam?: unknown }).stohrTeam
          return json(c, 200, { ok: true })
        }),
      ),
    )
    const req = new Request("http://test.local/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    ;(req as { peerIp?: string }).peerIp = "10.0.0.7"
    ;(req as { stohrTeam?: unknown }).stohrTeam = { id: 2 }
    const res = await probe(req)
    expect(res.status).toBe(200)
    expect(seen.peerIp).toBe("10.0.0.7")
    expect(seen.stash).toEqual({ id: 2 })
  })
})

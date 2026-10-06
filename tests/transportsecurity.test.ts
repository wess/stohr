import { describe, expect, test } from "bun:test"
import { createConn, get, json, pipeline, post, router } from "@atlas/server"
import { healthRoutes } from "../src/observability/health.ts"
import { recordRequest, renderMetrics } from "../src/observability/metrics.ts"
import { withSecurityHeaders } from "../src/security/headers.ts"
import { parseJson } from "../src/util/json/index.ts"
import { runProcess } from "../src/util/process/index.ts"
import { responseJson } from "../src/util/response/index.ts"
import { safeFetch } from "../src/util/safeurl/index.ts"
import { fakeStore } from "./helpers/http.ts"

describe("resource boundaries", () => {
  test("JSON parsing caps declared and streamed bodies and rejects malformed JSON", async () => {
    const app = router(post("/json", pipeline(parseJson)(c => json(c, 200, c.body))))
    const request = (body: string, headers: Record<string, string> = {}) =>
      app(new Request("http://test.local/json", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }))
    expect((await request('{"v":1}')).status).toBe(200)
    expect((await request("{")).status).toBe(400)
    expect((await request("{}", { "content-length": String(1024 * 1024 + 1) })).status).toBe(413)
    expect((await request(JSON.stringify("x".repeat(1024 * 1024)), { "content-length": "1" })).status).toBe(413)
    const req = new Request("http://test.local/json", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    Object.assign(req, { peerIp: "192.0.2.1", stohrTeam: { team: { id: 42 } } })
    const parsed = await parseJson(createConn(req))
    expect((parsed.request as any).peerIp).toBe("192.0.2.1")
    expect((parsed.request as any).stohrTeam.team.id).toBe(42)
  })

  test("odd HTTP verbs cannot grow the metrics label set", () => {
    for (let n = 0; n < 1000; n++) recordRequest(`CUSTOM${n}`, 404, 1)
    const metrics = renderMetrics()
    expect(metrics).toContain('method="OTHER"')
    expect(metrics).not.toContain("CUSTOM")
  })

  test("dynamic responses override caching even when a route requested public caching", async () => {
    const fetch = withSecurityHeaders(() => new Response("private", { headers: { "cache-control": "public, max-age=3600" } }))
    const res = await fetch(new Request("http://test.local/private"))
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  test("readiness requests share one backend probe", async () => {
    let dbReads = 0
    let blobReads = 0
    const db = { one: async () => { dbReads++; await Bun.sleep(10); return {} } } as any
    const store = { ...fakeStore, get: async () => { blobReads++; throw new Error("404") } }
    const app = router(...healthRoutes(db, store))
    const responses = await Promise.all(Array.from({ length: 30 }, () => app(new Request("http://test.local/readyz"))))
    expect(responses.every(r => r.status === 200)).toBe(true)
    expect(dbReads).toBe(1)
    expect(blobReads).toBe(1)
  })

  test("parser output and runtime are bounded", async () => {
    const output = await runProcess(["bun", "-e", 'process.stdout.write("x".repeat(100000))'], null, { maxBytes: 1024, timeoutMs: 1000 })
    expect(output.ok).toBe(false)
    expect(output.error).toContain("exceeds limit")
    const stderr = await runProcess(["bun", "-e", 'process.stderr.write("x".repeat(100000))'], null, { maxBytes: 1024, timeoutMs: 1000 })
    expect(stderr.ok).toBe(false)
    const timeout = await runProcess(["bun", "-e", "await Bun.sleep(10000)"], new Uint8Array(100), { maxBytes: 1024, timeoutMs: 50 })
    expect(timeout.ok).toBe(false)
    expect(timeout.error).toContain("timed out")
    const good = await runProcess(["bun", "-e", 'process.stdout.write("ok")'], null, { maxBytes: 1024, timeoutMs: 1000 })
    expect(new TextDecoder().decode(good.stdout)).toBe("ok")
  })

  test("remote JSON has a streaming ceiling", async () => {
    const small = await responseJson(new Response('{"ok":true}'), 100)
    expect(small).toEqual({ ok: true })
    let cancelled = false
    const stream = new ReadableStream({
      pull(c) { c.enqueue(new Uint8Array(101)) },
      cancel() { cancelled = true },
    })
    await expect(responseJson(new Response(stream), 100)).rejects.toThrow("exceeds limit")
    expect(cancelled).toBe(true)
  })

  test("outbound requests connect to the vetted address and keep the origin identity", async () => {
    let lookups = 0
    let called: { url: string; init: any } | null = null
    const lookupImpl = async () => { lookups++; return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1" }] }
    const fetchImpl = (async (url: any, init: any) => { called = { url: String(url), init }; return new Response("ok") }) as typeof fetch
    await safeFetch("https://files.example.org:8443/hook", {}, { lookupImpl, fetchImpl })
    expect(lookups).toBe(1)
    expect(called!.url).toBe("https://93.184.216.34:8443/hook")
    expect(new Headers(called!.init.headers).get("host")).toBe("files.example.org:8443")
    expect(called!.init.tls.serverName).toBe("files.example.org")
    expect(called!.init.proxy).toBe(false)
  })
})

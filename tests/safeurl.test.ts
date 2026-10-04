import { describe, expect, test } from "bun:test"
import { checkUrl, isPrivateAddress, safeFetch } from "../src/util/safeurl/index.ts"

describe("isPrivateAddress", () => {
  test("rejects every non-routable v4 range", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "169.254.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "192.0.0.5",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
  })

  test("accepts public v4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "172.15.255.255"]) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })

  test("rejects loopback, link-local, ULA, mapped and nat64 v6", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "febf::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "ff02::1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
  })

  test("accepts public v6 and mapped public v4", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false)
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false)
  })

  test("garbage is treated as private", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true)
    expect(isPrivateAddress("")).toBe(true)
  })
})

describe("checkUrl", () => {
  test("https to a public literal passes", async () => {
    const r = await checkUrl("https://93.184.216.34/hook")
    expect(r.ok).toBe(true)
  })

  test("private literals fail without DNS", async () => {
    for (const u of [
      "https://127.0.0.1/",
      "https://10.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
      "https://[fe80::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://2130706433/",
      "https://0x7f.1/",
    ]) {
      const r = await checkUrl(u)
      expect(r.ok).toBe(false)
    }
  })

  test("localhost names fail without DNS", async () => {
    expect((await checkUrl("https://localhost/")).ok).toBe(false)
    expect((await checkUrl("https://api.localhost/")).ok).toBe(false)
  })

  test("scheme policy", async () => {
    expect((await checkUrl("http://93.184.216.34/")).ok).toBe(false)
    expect((await checkUrl("http://93.184.216.34/", { allowHttp: true })).ok).toBe(true)
    expect((await checkUrl("ftp://93.184.216.34/")).ok).toBe(false)
    expect((await checkUrl("file:///etc/passwd")).ok).toBe(false)
    expect((await checkUrl("javascript:alert(1)")).ok).toBe(false)
    expect((await checkUrl("not a url")).ok).toBe(false)
  })

  test("allowPrivate is the explicit opt-out", async () => {
    expect((await checkUrl("http://127.0.0.1:3000/", { allowHttp: true, allowPrivate: true })).ok).toBe(true)
  })

  test("hostnames resolving to loopback fail", async () => {
    // localhost resolves via the OS resolver on every platform we run on;
    // this exercises the lookup path rather than the literal-name shortcut
    const r = await checkUrl("https://localhost./")
    expect(r.ok).toBe(false)
  })
})

type Call = { url: string; init: RequestInit }

// fetch stand-in: a scripted list of responses keyed by URL, recording what was asked
const scripted = (script: Record<string, () => Response>) => {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init: init ?? {} })
    const make = script[url]
    if (!make) return new Response("unscripted", { status: 599 })
    return make()
  }) as typeof fetch
  return { calls, fetchImpl }
}

const redirectTo = (location: string, status = 302) => () => new Response(null, { status, headers: { location } })

describe("safeFetch", () => {
  test("a redirect to a private address is refused", async () => {
    const { calls, fetchImpl } = scripted({
      "https://93.184.216.34/start": redirectTo("http://169.254.169.254/latest/meta-data"),
    })
    await expect(
      safeFetch("https://93.184.216.34/start", { method: "POST", body: "x" }, { fetchImpl, allowHttp: true }),
    ).rejects.toThrow(/redirect/)
    // the metadata endpoint was never contacted
    expect(calls.map(c => c.url)).toEqual(["https://93.184.216.34/start"])
  })

  test("every hop is fetched with redirect: manual and public hops are followed", async () => {
    const { calls, fetchImpl } = scripted({
      "https://93.184.216.34/a": redirectTo("https://1.1.1.1/b", 307),
      "https://1.1.1.1/b": redirectTo("/c", 302),
      "https://1.1.1.1/c": () => new Response("done", { status: 200 }),
    })
    const res = await safeFetch("https://93.184.216.34/a", { method: "POST", body: "payload" }, { fetchImpl })
    expect(res.status).toBe(200)
    expect(calls.map(c => c.url)).toEqual(["https://93.184.216.34/a", "https://1.1.1.1/b", "https://1.1.1.1/c"])
    for (const c of calls) expect(c.init.redirect).toBe("manual")
    // 307 keeps the POST + body, 302 after a POST becomes a bodiless GET
    expect(calls[1]!.init.method).toBe("POST")
    expect(calls[1]!.init.body).toBe("payload")
    expect(calls[2]!.init.method).toBe("GET")
    expect(calls[2]!.init.body).toBeUndefined()
  })

  test("authorization does not cross origins", async () => {
    const { calls, fetchImpl } = scripted({
      "https://93.184.216.34/a": redirectTo("https://1.1.1.1/b", 307),
      "https://1.1.1.1/b": () => new Response("ok"),
    })
    await safeFetch("https://93.184.216.34/a", { headers: { authorization: "Bearer t", "x-keep": "1" } }, { fetchImpl })
    const hop = new Headers(calls[1]!.init.headers)
    expect(hop.get("authorization")).toBeNull()
    expect(hop.get("x-keep")).toBe("1")
  })

  test("the redirect budget is bounded and the final 3xx is returned as-is", async () => {
    const { calls, fetchImpl } = scripted({
      "https://93.184.216.34/1": redirectTo("https://93.184.216.34/2"),
      "https://93.184.216.34/2": redirectTo("https://93.184.216.34/3"),
      "https://93.184.216.34/3": redirectTo("https://93.184.216.34/4"),
      "https://93.184.216.34/4": redirectTo("https://93.184.216.34/5"),
      "https://93.184.216.34/5": () => new Response("never"),
    })
    const res = await safeFetch("https://93.184.216.34/1", {}, { fetchImpl, maxRedirects: 2 })
    expect(res.status).toBe(302)
    expect(calls).toHaveLength(3)
  })

  test("maxRedirects: 0 never follows", async () => {
    const { calls, fetchImpl } = scripted({
      "https://93.184.216.34/a": redirectTo("https://1.1.1.1/b"),
    })
    const res = await safeFetch("https://93.184.216.34/a", {}, { fetchImpl, maxRedirects: 0 })
    expect(res.status).toBe(302)
    expect(calls).toHaveLength(1)
  })

  test("the initial URL is checked before any fetch", async () => {
    const { calls, fetchImpl } = scripted({})
    await expect(safeFetch("http://127.0.0.1:5432/", {}, { fetchImpl, allowHttp: true })).rejects.toThrow(/Refusing/)
    expect(calls).toHaveLength(0)
  })
})

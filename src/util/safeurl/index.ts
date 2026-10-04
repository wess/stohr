import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

// guard for outbound requests to caller-supplied addresses: webhooks,
// federation peers, pairing introducers. resolves the host and refuses
// anything landing on loopback, RFC1918, link-local (cloud metadata lives
// there), CGNAT, ULA or a v4-mapped v6 address, then follows redirects by
// hand so every hop gets the same treatment.
//
// NB: resolve-then-connect is two lookups. a hostile resolver can answer
// differently the second time and bun's fetch has no connect hook to pin
// the address, so short-TTL rebinding is the residual risk.

export type SafeUrlOpts = {
  allowHttp?: boolean
  allowPrivate?: boolean
  // 0 returns the 3xx response untouched instead of following it
  maxRedirects?: number
  fetchImpl?: typeof fetch
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string }

// [network, prefix bits]
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]

const v4ToInt = (ip: string): number | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const octet = Number(p)
    if (octet > 255) return null
    n = n * 256 + octet
  }
  return n
}

const inBlock = (ip: number, network: string, bits: number): boolean => {
  const shift = 32 - bits
  return ip >>> shift === (v4ToInt(network) as number) >>> shift
}

const isPrivateV4 = (ip: number): boolean => V4_BLOCKED.some(([net, bits]) => inBlock(ip, net, bits))

// expands to eight 16-bit groups; a dotted v4 tail (::ffff:1.2.3.4) becomes
// the last two groups
const parseV6 = (ip: string): number[] | null => {
  let s = ip
  const lastColon = s.lastIndexOf(":")
  const tail = s.slice(lastColon + 1)
  if (tail.includes(".")) {
    const v4 = v4ToInt(tail)
    if (v4 === null) return null
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - rest.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const out: number[] = []
  for (const g of [...head, ...Array<string>(missing).fill("0"), ...rest]) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
    out.push(Number.parseInt(g, 16))
  }
  return out
}

export const isPrivateAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) {
    const n = v4ToInt(address)
    return n === null ? true : isPrivateV4(n)
  }
  if (family !== 6) return true
  const g = parseV6(address)
  if (!g) return true
  const leading = g.slice(0, 5).every(x => x === 0)
  // ::, ::1 and the deprecated ::a.b.c.d form
  if (leading && g[5] === 0) return true
  // v4-mapped
  if (leading && g[5] === 0xffff) return isPrivateV4(g[6]! * 65536 + g[7]!)
  // nat64
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isPrivateV4(g[6]! * 65536 + g[7]!)
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return true
  if ((g[0]! & 0xffc0) === 0xfe80) return true
  if ((g[0]! & 0xff00) === 0xff00) return true
  return false
}

const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, "")

const isLocalName = (host: string): boolean => host === "localhost" || host.endsWith(".localhost")

export const checkUrl = async (raw: string, opts: SafeUrlOpts = {}): Promise<UrlCheck> => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: "Invalid URL" }
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    return { ok: false, error: opts.allowHttp ? "Only http(s) URLs are allowed" : "Only https URLs are allowed" }
  }
  const host = hostOf(url)
  if (!host) return { ok: false, error: "URL has no host" }
  if (opts.allowPrivate) return { ok: true, url }
  if (isLocalName(host)) return { ok: false, error: "Host is not publicly routable" }
  if (isIP(host)) {
    return isPrivateAddress(host) ? { ok: false, error: "Address is not publicly routable" } : { ok: true, url }
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return { ok: false, error: "Host did not resolve" }
  }
  if (addresses.length === 0) return { ok: false, error: "Host did not resolve" }
  if (addresses.some(a => isPrivateAddress(a.address))) {
    return { ok: false, error: "Host resolves to a non-public address" }
  }
  return { ok: true, url }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

// fetch spec: 303 always becomes GET, 301/302 do when the request was POST
const dropsBody = (status: number, method: string): boolean =>
  status === 303 || ((status === 301 || status === 302) && method === "POST")

// throws when the URL or any redirect hop fails checkUrl; past maxRedirects
// the 3xx response is handed back as-is so callers can record the status
export const safeFetch = async (raw: string, init: RequestInit = {}, opts: SafeUrlOpts = {}): Promise<Response> => {
  const max = opts.maxRedirects ?? 3
  const doFetch = opts.fetchImpl ?? fetch
  let target = raw
  let current: RequestInit = init
  for (let hop = 0; ; hop++) {
    const check = await checkUrl(target, opts)
    if (!check.ok) throw new Error(`Refusing to fetch ${hop === 0 ? "URL" : "redirect"}: ${check.error}`)
    const res = await doFetch(check.url.toString(), { ...current, redirect: "manual" })
    const location = res.headers.get("location")
    if (!REDIRECTS.has(res.status) || !location || hop >= max) return res
    await res.body?.cancel().catch(() => {})
    const next = new URL(location, check.url)
    const method = (current.method ?? "GET").toUpperCase()
    const headers = new Headers(current.headers)
    // credentials never cross an origin boundary
    if (next.origin !== check.url.origin) {
      headers.delete("authorization")
      headers.delete("cookie")
    }
    current = dropsBody(res.status, method)
      ? { ...current, method: "GET", body: undefined, headers }
      : { ...current, headers }
    target = next.toString()
  }
}

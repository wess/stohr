// Trusted-proxy awareness shared by the API (rate-limit buckets, audit logs)
// and the web front door (which stamps X-Forwarded-For on the way through).
// TRUSTED_PROXIES is a comma-separated list of IPv4 addresses or CIDRs; any
// other address in a forwarding chain is treated as the client.

export type Cidr = { addr: number; mask: number }

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

const parseCidr = (raw: string): Cidr | null => {
  const [ip, prefix] = raw.includes("/") ? raw.split("/") : [raw, "32"]
  const bits = Number(prefix)
  if (!ip || !Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const addr = ipv4ToInt(ip)
  if (addr === null) return null
  const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0
  return { addr: (addr & mask) >>> 0, mask }
}

export const parseTrustedProxies = (raw: string | undefined): Cidr[] =>
  (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is Cidr => c !== null)

const TRUSTED = parseTrustedProxies(process.env.TRUSTED_PROXIES)

// dual-stack sockets report IPv4 peers as ::ffff:a.b.c.d
export const normalizeIp = (ip: string): string => {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim())
  return m ? m[1]! : ip.trim()
}

export const isTrustedProxy = (ip: string, trusted: Cidr[] = TRUSTED): boolean => {
  if (trusted.length === 0) return false
  const n = ipv4ToInt(normalizeIp(ip))
  if (n === null) return false
  return trusted.some(c => (n & c.mask) >>> 0 === c.addr)
}

// Walk X-Forwarded-For from the right. The right-most entry was appended by
// the hop that connected to us, so it is the only one we can vouch for; keep
// stepping left while the entries are proxies we trust and stop at the first
// one we don't — that is the client. Anything left of it is whatever the
// client chose to send and proves nothing.
export const forwardedClientIp = (header: string | null, trusted: Cidr[] = TRUSTED): string | null => {
  if (!header) return null
  const hops = header
    .split(",")
    .map(s => normalizeIp(s))
    .filter(Boolean)
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(hops[i]!, trusted)) return hops[i]!
  }
  // every hop is one of ours — the left-most is the furthest edge we know of
  return hops[0] ?? null
}

// The hostname a request was really addressed to. X-Forwarded-Host is only
// believed when the socket peer is one of ours (same rule as the client ip
// in src/security/ratelimit.ts); otherwise it is whatever the client typed.

import type { Cidr } from "../security/proxies.ts"
import { isTrustedProxy, normalizeIp } from "../security/proxies.ts"

// the socket peer withSecurityHeaders stashed; "unknown" when nothing did
export const socketPeer = (req: Request): string => normalizeIp((req as { peerIp?: string }).peerIp ?? "unknown")

// strip a port and a trailing dot; keep ipv6 literals intact
const hostnameOnly = (raw: string): string => {
  const v = raw.trim().toLowerCase()
  if (v.startsWith("[")) {
    const end = v.indexOf("]")
    return end === -1 ? v : v.slice(0, end + 1)
  }
  const colon = v.indexOf(":")
  const host = colon === -1 ? v : v.slice(0, colon)
  return host.endsWith(".") ? host.slice(0, -1) : host
}

export const effectiveHost = (req: Request, trusted?: Cidr[]): string => {
  const forwarded = isTrustedProxy(socketPeer(req), trusted) ? req.headers.get("x-forwarded-host") : null
  // a chain of proxies appends; the first entry is the client-facing edge
  const first = forwarded?.split(",")[0]?.trim()
  const host = first || req.headers.get("host") || new URL(req.url).host
  return hostnameOnly(host)
}

export const isLoopbackPeer = (req: Request): boolean => {
  const peer = socketPeer(req)
  return peer === "127.0.0.1" || peer === "::1" || peer.startsWith("127.")
}

export const isTrustedPeer = (req: Request, trusted?: Cidr[]): boolean => isTrustedProxy(socketPeer(req), trusted)

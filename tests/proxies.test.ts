import { describe, expect, test } from "bun:test"
import { forwardedClientIp, isTrustedProxy, normalizeIp, parseTrustedProxies } from "../src/security/proxies.ts"
import { clientIp } from "../src/security/ratelimit.ts"

const trusted = parseTrustedProxies("10.0.0.0/8, 192.168.1.5, garbage, 1.2.3.4/40")

describe("trusted proxies", () => {
  test("parses addresses and CIDRs, skips garbage", () => {
    expect(trusted).toHaveLength(2)
    expect(isTrustedProxy("10.42.0.7", trusted)).toBe(true)
    expect(isTrustedProxy("192.168.1.5", trusted)).toBe(true)
    expect(isTrustedProxy("192.168.1.6", trusted)).toBe(false)
    expect(isTrustedProxy("8.8.8.8", trusted)).toBe(false)
    expect(isTrustedProxy("::1", trusted)).toBe(false)
  })

  test("IPv4-mapped IPv6 peers normalize", () => {
    expect(normalizeIp("::ffff:10.0.0.9")).toBe("10.0.0.9")
    expect(isTrustedProxy("::ffff:10.0.0.9", trusted)).toBe(true)
  })

  test("X-Forwarded-For is walked from the right past trusted hops", () => {
    expect(forwardedClientIp("1.1.1.1, 2.2.2.2, 10.0.0.9", trusted)).toBe("2.2.2.2")
    expect(forwardedClientIp("1.1.1.1, 10.0.0.9", trusted)).toBe("1.1.1.1")
    expect(forwardedClientIp("spoofed, 3.3.3.3", trusted)).toBe("3.3.3.3")
    expect(forwardedClientIp("3.3.3.3", trusted)).toBe("3.3.3.3")
    // a chain made only of our own proxies: furthest edge we know of
    expect(forwardedClientIp("10.0.0.1, 10.0.0.2", trusted)).toBe("10.0.0.1")
    expect(forwardedClientIp(null, trusted)).toBeNull()
    expect(forwardedClientIp("", trusted)).toBeNull()
  })
})

describe("clientIp", () => {
  const withPeer = (peer: string, headers: Record<string, string>) => {
    const req = new Request("http://test.local/", { headers })
    ;(req as { peerIp?: string }).peerIp = peer
    return req
  }

  test("ignores forwarding headers from an untrusted peer", () => {
    // TRUSTED_PROXIES is unset under test, so nothing is trusted
    expect(clientIp(withPeer("5.5.5.5", { "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }))).toBe("5.5.5.5")
    expect(clientIp(withPeer("::ffff:5.5.5.5", {}))).toBe("5.5.5.5")
  })
})

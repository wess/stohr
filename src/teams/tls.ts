// Caddy's on-demand TLS asks us before issuing a certificate for a name, so
// nobody can burn rate limits on arbitrary subdomains. Only the edge may
// ask: the socket peer has to be loopback (single-container image) or a
// trusted proxy (compose, where caddy and the api share a bridge). The web
// front door refuses /api/internal/* outright, so the public hostname never
// reaches this route at all.

import type { Connection } from "@atlas/db"
import { get, json } from "@atlas/server"
import type { Cidr } from "../security/proxies.ts"
import { checkRate } from "../security/ratelimit.ts"
import { isLoopbackPeer, isTrustedPeer, socketPeer } from "./host.ts"
import { teamByDomain, teamBySlug } from "./resolve.ts"
import { parseHost } from "./slug.ts"
import type { HostConfig } from "./urls.ts"

// a handshake with an unknown name costs one ask; a flood of them must not
// turn into a slug lookup per hit, so each asking peer gets a budget
const ASKS_PER_MINUTE = 60

export const tlsAllowRoutes = (db: Connection, cfg: HostConfig & { trusted?: Cidr[] }) => {
  let appHost: string | null = null
  try {
    appHost = new URL(cfg.appUrl).hostname.toLowerCase()
  } catch {
    appHost = null
  }

  return [
    get("/internal/domains/resolve", async c => {
      if (!isLoopbackPeer(c.request) && !isTrustedPeer(c.request, cfg.trusted))
        return json(c, 403, { error: "Forbidden" })
      const domain = (c.query.domain ?? "").trim().toLowerCase().replace(/\.$/, "")
      if (cfg.rootDomain && domain && (await teamByDomain(db, domain))) return json(c, 200, { allow: true })
      return json(c, 404, { allow: false })
    }),
    get("/internal/tls/allow", async c => {
      if (!isLoopbackPeer(c.request) && !isTrustedPeer(c.request, cfg.trusted)) {
        return json(c, 403, { error: "Forbidden" })
      }
      const rate = await checkRate(db, `tls:allow:${socketPeer(c.request)}`, ASKS_PER_MINUTE, 60)
      if (!rate.ok) {
        return json(c, 429, { allow: false, error: "Too many requests", retry_after: rate.retryAfterSeconds })
      }
      const domain = (c.query.domain ?? "").trim().toLowerCase().replace(/\.$/, "")
      if (!domain) return json(c, 400, { error: "domain required" })
      if (domain === appHost || (cfg.rootDomain && domain === cfg.rootDomain.toLowerCase())) {
        return json(c, 200, { allow: true })
      }
      // reserved labels (root.<domain> among them) parse as invalid
      const parsed = parseHost(domain, cfg.rootDomain)
      // a suspended team keeps its certificate so the 403 page is reachable
      if (parsed.kind === "team" && (await teamBySlug(db, parsed.slug))) return json(c, 200, { allow: true })
      if (cfg.rootDomain && parsed.kind === "root" && (await teamByDomain(db, domain)))
        return json(c, 200, { allow: true })
      return json(c, 404, { allow: false })
    }),
  ]
}

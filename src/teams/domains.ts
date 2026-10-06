import { Resolver } from "node:dns/promises"
import { isIP } from "node:net"
import type { Connection } from "@atlas/db"
import type { Route } from "@atlas/server"
import { del, get, json, pipeline, post, put } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate } from "../security/ratelimit.ts"
import { parseJson } from "../util/json/index.ts"
import { randomToken } from "../util/token.ts"
import { teamAdminOnly } from "./guards.ts"
import { teamFor } from "./request.ts"
import type { Team } from "./resolve.ts"
import { clearTeamCache } from "./resolve.ts"
import type { HostConfig } from "./urls.ts"
import { teamBaseUrl } from "./urls.ts"

export type TxtLookup = (name: string) => Promise<string[][]>
const resolver = new Resolver({ timeout: 3000, tries: 2 })
const lookupTxt: TxtLookup = name => resolver.resolveTxt(name)

type DomainRow = {
  custom_domain: string | null
  domain_token: string | null
  domain_verified_at: string | Date | null
}

export const normalizeDomain = (value: unknown, hosts: HostConfig): string | null => {
  if (typeof value !== "string") return null
  const domain = value.trim().toLowerCase().replace(/\.$/, "")
  if (domain.length > 253 || isIP(domain) || !domain.includes(".")) return null
  const labels = domain.split(".")
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  if (!/^[a-z]{2,63}$/.test(labels.at(-1)!)) return null
  const blocked = [
    hosts.rootDomain,
    new URL(hosts.appUrl).hostname,
    "localhost",
    "local",
    "internal",
    "lan",
    "home",
    "home.arpa",
    "onion",
    "test",
    "invalid",
    "example",
  ]
  if (blocked.some(host => host && (domain === host.toLowerCase() || domain.endsWith(`.${host.toLowerCase()}`))))
    return null
  return domain
}

const domainState = (row: DomainRow, hosts: HostConfig, team: Pick<Team, "id" | "slug">) => ({
  domain: row.custom_domain,
  verified: row.domain_verified_at != null,
  verification_name: row.custom_domain ? `_stohr.${row.custom_domain}` : null,
  verification_value: row.domain_token ? `stohr-verification=${row.domain_token}` : null,
  target: hosts.rootDomain ? `${team.slug}.${hosts.rootDomain}` : null,
  default_url: hosts.rootDomain ? teamBaseUrl(team, hosts) : null,
})

export const domainRoutes = (
  db: Connection,
  secret: string,
  hosts: HostConfig,
  txt: TxtLookup = lookupTxt,
): Route[] => {
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), teamAdminOnly(db))
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), teamAdminOnly(db), parseJson)
  const read = async (id: number): Promise<DomainRow> =>
    (await db.one({
      text: "SELECT custom_domain, domain_token, domain_verified_at FROM teams WHERE id = $1",
      values: [id],
    })) as DomainRow

  return [
    get(
      "/team/domain",
      guard(async c => {
        const { team } = teamFor(c.request)
        return json(c, 200, {
          ...domainState(await read(team.id), hosts, team),
          enabled: !!hosts.rootDomain && team.id !== 1,
        })
      }),
    ),
    put(
      "/team/domain",
      authed(async c => {
        const { team } = teamFor(c.request)
        if (!hosts.rootDomain || team.id === 1) return json(c, 422, { error: "Custom domains require a tenant team" })
        const body = (c.body ?? {}) as { domain?: unknown; custom_domain?: unknown; customDomain?: unknown }
        const domain = normalizeDomain(body.domain ?? body.custom_domain ?? body.customDomain, hosts)
        if (!domain)
          return json(c, 422, { error: "Enter a public hostname such as files.yourcompany.com, without a URL or port" })
        const current = await read(team.id)
        if (current.custom_domain === domain) return json(c, 200, domainState(current, hosts, team))
        try {
          await db.execute({
            text: "UPDATE teams SET custom_domain = $1, domain_token = $2, domain_verified_at = NULL WHERE id = $3",
            values: [domain, randomToken(), team.id],
          })
        } catch (e) {
          if ((e as { errno?: string }).errno === "23505")
            return json(c, 409, { error: "This domain is already assigned to a team" })
          throw e
        }
        clearTeamCache()
        logEvent(db, {
          userId: (c.assigns.auth as { id: number }).id,
          teamId: team.id,
          event: "team.domain_added",
          metadata: { domain },
        })
        return json(c, 200, domainState(await read(team.id), hosts, team))
      }),
    ),
    post(
      "/team/domain/verify",
      guard(async c => {
        const { team } = teamFor(c.request)
        const rate = await checkRate(db, `team:domain:${team.id}`, 10, 60)
        if (!rate.ok) return json(c, 429, { error: "Too many DNS checks. Try again in a minute." })
        const row = await read(team.id)
        if (!row.custom_domain || !row.domain_token) return json(c, 422, { error: "Add a domain first" })
        let records: string[][]
        try {
          records = await txt(`_stohr.${row.custom_domain}`)
        } catch {
          return json(c, 422, {
            error: "DNS TXT record is not available yet. Check the record and try again after DNS updates.",
          })
        }
        if (!records.some(parts => parts.join("") === `stohr-verification=${row.domain_token}`)) {
          return json(c, 422, {
            error: "DNS TXT record does not match. Copy the verification value exactly and try again.",
          })
        }
        // the domain may have changed while the resolver was answering
        const updated = await db.one({
          text: "UPDATE teams SET domain_verified_at = NOW() WHERE id = $1 AND custom_domain = $2 AND domain_token = $3 RETURNING id",
          values: [team.id, row.custom_domain, row.domain_token],
        })
        if (!updated) return json(c, 409, { error: "Domain changed during verification. Try again." })
        clearTeamCache()
        logEvent(db, {
          userId: (c.assigns.auth as { id: number }).id,
          teamId: team.id,
          event: "team.domain_verified",
          metadata: { domain: row.custom_domain },
        })
        return json(c, 200, domainState(await read(team.id), hosts, team))
      }),
    ),
    del(
      "/team/domain",
      guard(async c => {
        const { team } = teamFor(c.request)
        await db.execute({
          text: "UPDATE teams SET custom_domain = NULL, domain_token = NULL, domain_verified_at = NULL WHERE id = $1",
          values: [team.id],
        })
        clearTeamCache()
        logEvent(db, { userId: (c.assigns.auth as { id: number }).id, teamId: team.id, event: "team.domain_removed" })
        return json(c, 200, domainState(await read(team.id), hosts, team))
      }),
    ),
  ]
}

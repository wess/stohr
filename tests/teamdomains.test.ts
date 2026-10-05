import { beforeEach, describe, expect, test } from "bun:test"
import { normalizeDomain } from "../src/teams/domains.ts"
import { teamBaseUrl } from "../src/teams/urls.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { addMember, ROOT, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

const DOMAIN = "files.customer.com"
let records: string[][] = []
let queried = ""
const app = buildApp(db, TEST_SECRET, { rootDomain: ROOT, domainTxt: async name => {
  queried = name
  return records
} })
beforeEach(async () => { await truncateAll(); records = []; queried = "" })

const setup = async () => {
  const owner = await signupOwner(app)
  const team = await teamWithAdmin(app, owner, "acme")
  const options = { host: team.host, token: team.admin.token }
  const saved = await callJson(app, "/team/domain", { ...options, method: "PUT", body: { domain: DOMAIN } })
  expect(saved.status).toBe(200)
  return { owner, team, options, saved }
}

describe("custom team domains", () => {
  test("normalizes public names and refuses URLs, IPs, private and platform names", () => {
    const hosts = { rootDomain: ROOT, appUrl: "https://app.stohr.io" }
    expect(normalizeDomain(" Files.Customer.com. ", hosts)).toBe(DOMAIN)
    for (const name of ["https://files.customer.com", "files.customer.com:443", "*.customer.com", "127.0.0.1", "localhost", "files.local", "files.internal", ROOT, `acme.${ROOT}`, "app.stohr.io", "a..com", "-bad.com", null, 123]) {
      expect(normalizeDomain(name, hosts)).toBeNull()
    }
  })

  test("pending domains cannot obtain certificates; verification checks exact TXT value", async () => {
    const { options, saved } = await setup()
    const tls = () => callJson(app, `/internal/tls/allow?domain=${DOMAIN}`, { peer: "127.0.0.1" })
    expect(saved.body.verified).toBe(false)
    expect((await callJson(app, "/setup", { host: DOMAIN })).status).toBe(404)
    expect((await tls()).status).toBe(404)
    records = [["wrong"]]
    expect((await callJson(app, "/team/domain/verify", { ...options, method: "POST" })).status).toBe(422)
    records = [[saved.body.verification_value.slice(0, 12), saved.body.verification_value.slice(12)]]
    const verified = await callJson(app, "/team/domain/verify", { ...options, method: "POST" })
    expect(queried).toBe(`_stohr.${DOMAIN}`)
    expect(verified.status).toBe(200)
    expect(verified.body.verified).toBe(true)
    expect((await tls()).status).toBe(200)
  })

  test("verified custom host shares the tenant boundary and keeps original-host links on that host", async () => {
    const { options, saved, owner, team } = await setup()
    records = [[saved.body.verification_value]]
    await callJson(app, "/team/domain/verify", { ...options, method: "POST" })
    const info = await callJson(app, "/team", { token: team.admin.token, host: DOMAIN })
    expect(info.status).toBe(200)
    expect(info.body.id).toBe(team.created.team.id)
    expect(info.body.base_url).toBe(`https://${DOMAIN}`)
    const probe = await callJson(app, "/setup", { host: DOMAIN })
    expect(probe.body.is_root).toBe(false)
    expect(probe.body.team.slug).toBe("acme")
    const original = await callJson(app, "/team", options)
    expect(original.status).toBe(200)
    expect(original.body.base_url).toContain(team.host)
    expect((await callJson(app, "/me", { token: owner.token, host: DOMAIN })).status).toBe(401)
    const other = await teamWithAdmin(app, owner, "other")
    expect((await callJson(app, "/me", { token: other.admin.token, host: DOMAIN })).status).toBe(401)
    expect(teamBaseUrl({ id: 2, slug: "acme", custom_domain: DOMAIN, domain_verified_at: "now" }, { rootDomain: ROOT, appUrl: "https://stohr.test" })).toBe(`https://${DOMAIN}`)
  })

  test("a DNS answer cannot activate a domain that was replaced while checking", async () => {
    const { options, saved } = await setup()
    let answer!: (records: string[][]) => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const racing = buildApp(db, TEST_SECRET, { rootDomain: ROOT, domainTxt: async () => {
      started()
      return await new Promise<string[][]>(resolve => { answer = resolve })
    } })
    const checking = callJson(racing, "/team/domain/verify", { ...options, method: "POST" })
    await entered
    const replacement = await callJson(app, "/team/domain", { ...options, method: "PUT", body: { domain: "assets.customer.com" } })
    expect(replacement.status).toBe(200)
    answer([[saved.body.verification_value]])
    expect((await checking).status).toBe(409)
    const current = await callJson(app, "/team/domain", options)
    expect(current.body.domain).toBe("assets.customer.com")
    expect(current.body.verified).toBe(false)
  })

  test("edge routing is private and does not consume the certificate-issuance budget", async () => {
    const { options, saved } = await setup()
    records = [[saved.body.verification_value]]
    await callJson(app, "/team/domain/verify", { ...options, method: "POST" })
    const path = `/internal/domains/resolve?domain=${DOMAIN}`
    expect((await callJson(app, path, { peer: "8.8.8.8" })).status).toBe(403)
    for (let i = 0; i < 65; i++) expect((await callJson(app, path, { peer: "127.0.0.1" })).status).toBe(200)
    expect((await callJson(app, `/internal/tls/allow?domain=${DOMAIN}`, { peer: "127.0.0.1" })).status).toBe(200)
  })

  test("members cannot manage domains, root cannot add one, and claims are unique", async () => {
    const { owner, team, options, saved } = await setup()
    const member = await addMember(app, team.host, team.admin, "member")
    for (const [path, method] of [["/team/domain", "GET"], ["/team/domain", "PUT"], ["/team/domain/verify", "POST"], ["/team/domain", "DELETE"]] as const) {
      expect((await callJson(app, path!, { host: team.host, token: member.token, method: method!, body: { domain: DOMAIN } })).status).toBe(403)
    }
    expect((await callJson(app, "/team/domain", { host: ROOT, token: owner.token, method: "PUT", body: { domain: DOMAIN } })).status).toBe(422)
    const other = await teamWithAdmin(app, owner, "other")
    expect((await callJson(app, "/team/domain", { host: other.host, token: other.admin.token, method: "PUT", body: { domain: DOMAIN } })).status).toBe(409)
    const same = await callJson(app, "/team/domain", { ...options, method: "PUT", body: { customDomain: DOMAIN } })
    expect(same.body.verification_value).toBe(saved.body.verification_value)
  })

  test("suspended teams keep TLS but refuse access; deleted and removed domains lose TLS", async () => {
    const { owner, team, options, saved } = await setup()
    records = [[saved.body.verification_value]]
    await callJson(app, "/team/domain/verify", { ...options, method: "POST" })
    const edit = (body: object) => callJson(app, `/admin/teams/${team.created.team.id}`, { host: ROOT, token: owner.token, method: "PATCH", body })
    await edit({ suspended: true })
    expect((await callJson(app, "/setup", { host: DOMAIN })).status).toBe(403)
    expect((await callJson(app, `/internal/tls/allow?domain=${DOMAIN}`, { peer: "127.0.0.1" })).status).toBe(200)
    await edit({ suspended: false })
    await callJson(app, `/admin/teams/${team.created.team.id}`, { host: ROOT, token: owner.token, method: "DELETE" })
    expect((await callJson(app, `/internal/tls/allow?domain=${DOMAIN}`, { peer: "127.0.0.1" })).status).toBe(404)
    expect((await callJson(app, "/setup", { host: DOMAIN })).status).toBe(404)
    await callJson(app, `/admin/teams/${team.created.team.id}/restore`, { host: ROOT, token: owner.token, method: "POST" })
    expect((await callJson(app, "/team/domain", { ...options, method: "DELETE" })).status).toBe(200)
    expect((await callJson(app, "/setup", { host: DOMAIN })).status).toBe(404)
    expect((await callJson(app, `/internal/tls/allow?domain=${DOMAIN}`, { peer: "127.0.0.1" })).status).toBe(404)
  })
})

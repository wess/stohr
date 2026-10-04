import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { parseTrustedProxies } from "../src/security/proxies.ts"
import { effectiveHost } from "../src/teams/host.ts"
import { isReservedSlug, isValidSlug, parseHost, slugProblem } from "../src/teams/slug.ts"
import { teamBaseUrl, teamHostname } from "../src/teams/urls.ts"
import { buildApp, callJson, makeRequest } from "./helpers/http.ts"
import { createTeam, hostOf, ROOT, signupOwner } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

describe("slug rules", () => {
  test("shape: lowercase dns label, 2-63 chars, no edge hyphens", () => {
    expect(isValidSlug("acme")).toBe(true)
    expect(isValidSlug("a1-b2")).toBe(true)
    expect(isValidSlug("a")).toBe(false)
    expect(isValidSlug("-acme")).toBe(false)
    expect(isValidSlug("acme-")).toBe(false)
    expect(isValidSlug("Acme")).toBe(false)
    expect(isValidSlug("ac.me")).toBe(false)
    expect(isValidSlug("a".repeat(64))).toBe(false)
  })

  test("reserved names are refused even though they are valid labels", () => {
    for (const s of ["root", "www", "api", "admin", "app", "mail", "static", "s3", "webdav", "mcp"]) {
      expect(isValidSlug(s)).toBe(true)
      expect(isReservedSlug(s)).toBe(true)
      expect(slugProblem(s)).toBe("slug is reserved")
    }
    expect(slugProblem("acme")).toBeNull()
  })
})

describe("parseHost", () => {
  test("no ROOT_DOMAIN: everything is root", () => {
    expect(parseHost("acme.stohr.test", null)).toEqual({ kind: "root" })
    expect(parseHost("localhost", null)).toEqual({ kind: "root" })
  })

  test("root domain itself and hosts outside it are root", () => {
    expect(parseHost("stohr.test", ROOT)).toEqual({ kind: "root" })
    expect(parseHost("STOHR.TEST", ROOT)).toEqual({ kind: "root" })
    expect(parseHost("localhost", ROOT)).toEqual({ kind: "root" })
    expect(parseHost("10.0.0.5", ROOT)).toEqual({ kind: "root" })
    expect(parseHost("notstohr.test", ROOT)).toEqual({ kind: "root" })
  })

  test("one label under the root domain is a team", () => {
    expect(parseHost("acme.stohr.test", ROOT)).toEqual({ kind: "team", slug: "acme" })
    expect(parseHost("Acme.Stohr.Test", ROOT)).toEqual({ kind: "team", slug: "acme" })
  })

  test("deeper or malformed labels are nothing we serve", () => {
    expect(parseHost("a.b.stohr.test", ROOT)).toEqual({ kind: "invalid" })
    expect(parseHost("-x.stohr.test", ROOT)).toEqual({ kind: "invalid" })
    expect(parseHost(".stohr.test", ROOT)).toEqual({ kind: "invalid" })
  })
})

describe("effectiveHost trust rules", () => {
  const trusted = parseTrustedProxies("10.0.0.0/8")

  test("Host header wins when the peer is not a trusted proxy", () => {
    const req = makeRequest("/", { host: "acme.stohr.test:3001", headers: { "x-forwarded-host": "evil.stohr.test" } })
    expect(effectiveHost(req, trusted)).toBe("acme.stohr.test")
    const bare = makeRequest("/", { host: "acme.stohr.test", peer: "8.8.8.8", headers: { "x-forwarded-host": "evil.stohr.test" } })
    expect(effectiveHost(bare, trusted)).toBe("acme.stohr.test")
  })

  test("X-Forwarded-Host is believed from a trusted proxy, first hop only", () => {
    const req = makeRequest("/", {
      host: "web:3001",
      peer: "10.1.2.3",
      headers: { "x-forwarded-host": "Acme.Stohr.Test:443, inner.proxy" },
    })
    expect(effectiveHost(req, trusted)).toBe("acme.stohr.test")
  })

  test("falls back to the url authority without a Host header", () => {
    const req = new Request("http://beta.stohr.test:8080/x")
    expect(effectiveHost(req, trusted)).toBe("beta.stohr.test")
  })
})

describe("team urls", () => {
  test("root is APP_URL, teams take APP_URL's scheme and port under ROOT_DOMAIN", () => {
    const cfg = { rootDomain: "localhost", appUrl: "http://localhost:3001/" }
    expect(teamBaseUrl({ id: 1, slug: "root" }, cfg)).toBe("http://localhost:3001")
    expect(teamBaseUrl({ id: 7, slug: "acme" }, cfg)).toBe("http://acme.localhost:3001")
    const prod = { rootDomain: "storage.example", appUrl: "https://storage.example" }
    expect(teamBaseUrl({ id: 7, slug: "acme" }, prod)).toBe("https://acme.storage.example")
    expect(teamHostname({ id: 7, slug: "acme" }, prod)).toBe("acme.storage.example")
    expect(teamHostname({ id: 1, slug: "root" }, prod)).toBe("storage.example")
  })

  test("without ROOT_DOMAIN a team has no host of its own", () => {
    const cfg = { rootDomain: null, appUrl: "https://files.example" }
    expect(teamBaseUrl({ id: 7, slug: "acme" }, cfg)).toBe("https://files.example")
    expect(teamHostname({ id: 7, slug: "acme" }, cfg)).toBeNull()
    expect(teamHostname({ id: 1, slug: "root" }, cfg)).toBe("files.example")
  })
})

describe("withTeams resolution", () => {
  let app: ReturnType<typeof buildApp>

  beforeAll(() => {
    app = buildApp(db, TEST_SECRET, { rootDomain: ROOT, trusted: parseTrustedProxies("10.0.0.0/8") })
  })
  beforeEach(async () => {
    await truncateAll()
  })

  test("unknown subdomain is 404 before any route runs", async () => {
    const res = await callJson(app, "/setup", { host: hostOf("nobody") })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe("Unknown team")
    const deep = await callJson(app, "/setup", { host: "a.b.stohr.test" })
    expect(deep.status).toBe(404)
  })

  test("root domain and foreign hosts serve the root team", async () => {
    const root = await callJson(app, "/setup", { host: ROOT })
    expect(root.status).toBe(200)
    expect(root.body.needsSetup).toBe(true)
    const foreign = await callJson(app, "/setup", { host: "localhost" })
    expect(foreign.status).toBe(200)
  })

  test("a live team host resolves and only its own users see setup done", async () => {
    const owner = await signupOwner(app)
    await createTeam(app, owner, "acme")
    const res = await callJson(app, "/setup", { host: hostOf("acme") })
    expect(res.status).toBe(200)
    // tenants never self-bootstrap, even with no users
    expect(res.body.needsSetup).toBe(false)
  })

  test("X-Forwarded-Host from a trusted proxy picks the team", async () => {
    const owner = await signupOwner(app)
    await createTeam(app, owner, "acme")
    const viaProxy = await callJson(app, "/setup", {
      host: "web:3001",
      peer: "10.0.0.9",
      headers: { "x-forwarded-host": hostOf("ghost") },
    })
    expect(viaProxy.status).toBe(404)
    const spoofed = await callJson(app, "/setup", {
      host: ROOT,
      peer: "8.8.8.8",
      headers: { "x-forwarded-host": hostOf("ghost") },
    })
    expect(spoofed.status).toBe(200)
  })

  test("a deleted team's host stops resolving; restore brings it back", async () => {
    const owner = await signupOwner(app)
    const made = await createTeam(app, owner, "acme")
    const gone = await callJson(app, `/admin/teams/${made.team.id}`, { method: "DELETE", host: ROOT, token: owner.token })
    expect(gone.status).toBe(200)
    expect((await callJson(app, "/setup", { host: hostOf("acme") })).status).toBe(404)
    const back = await callJson(app, `/admin/teams/${made.team.id}/restore`, {
      method: "POST",
      host: ROOT,
      token: owner.token,
    })
    expect(back.status).toBe(200)
    expect((await callJson(app, "/setup", { host: hostOf("acme") })).status).toBe(200)
  })

  test("suspended team is 403 on every route except the infra paths", async () => {
    const owner = await signupOwner(app)
    const made = await createTeam(app, owner, "acme")
    const sus = await callJson(app, `/admin/teams/${made.team.id}`, {
      method: "PATCH",
      host: ROOT,
      token: owner.token,
      body: { suspended: true },
    })
    expect(sus.status).toBe(200)
    expect(sus.body.suspended_at).not.toBeNull()
    const blocked = await callJson(app, "/setup", { host: hostOf("acme") })
    expect(blocked.status).toBe(403)
    const login = await callJson(app, "/login", {
      method: "POST",
      host: hostOf("acme"),
      body: { identity: made.admin.email, password: "x" },
    })
    expect(login.status).toBe(403)
    // the tls allow-list still answers so the 403 page stays reachable
    const tls = await callJson(app, `/internal/tls/allow?domain=${hostOf("acme")}`, { host: hostOf("acme"), peer: "127.0.0.1" })
    expect(tls.status).toBe(200)
  })
})

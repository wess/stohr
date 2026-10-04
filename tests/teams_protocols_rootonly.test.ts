import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import type { App } from "./helpers/http.ts"
import { callJson } from "./helpers/http.ts"
import { buildProtocolApp, CASTLE_TOKEN } from "./helpers/protocolapp.ts"
import { login, ROOT, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

// Instance-level surfaces exist on the root host only. A tenant host does not
// refuse them, it has never heard of them — whoever asks, with whatever flag.

let app: App

beforeAll(() => {
  app = buildProtocolApp(db, TEST_SECRET)
})
beforeEach(async () => {
  await truncateAll()
})

// onRoot: what a tenant credential gets on the root host, where the route
// does exist — 401 from requireAuth, or 503 where the federation toggle
// (off by default) answers before any auth runs
const ROOT_ONLY: Array<{ method: "GET" | "POST"; path: string; body?: unknown; onRoot: number }> = [
  { method: "GET", path: "/admin/settings", onRoot: 401 },
  { method: "GET", path: "/ai/settings", onRoot: 401 },
  { method: "GET", path: "/admin/oauth/clients", onRoot: 401 },
  { method: "GET", path: "/admin/mcp/preview", onRoot: 401 },
  { method: "GET", path: "/admin/mcp/servers", onRoot: 401 },
  { method: "GET", path: "/me/federations", onRoot: 503 },
  { method: "GET", path: "/me/federations/instance/keys", onRoot: 503 },
  { method: "POST", path: "/federation/pair", body: { invite: "x" }, onRoot: 503 },
]

describe("root-only surfaces on a tenant host", () => {
  test("a team admin gets 404 on every one of them", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    for (const r of ROOT_ONLY) {
      const res = await callJson(app, r.path, { method: r.method, host: a.host, token: a.admin.token, body: r.body })
      expect(`${r.path} ${res.status}`).toBe(`${r.path} 404`)
    }
    const castle = await callJson(app, "/castle/health", { host: a.host, token: CASTLE_TOKEN })
    expect(castle.status).toBe(404)
  })

  test("is_owner on a tenant account changes nothing: 404 at home, 401 on root", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    await db.execute(
      from("users")
        .where(q => q("id").equals(a.created.admin.id))
        .update({ is_owner: true }),
    )
    // a fresh session so the flag is on the account the token names
    const fresh = await login(app, a.host, a.created.admin.email)
    expect(fresh.status).toBe(200)
    const token = fresh.body.token as string
    for (const r of ROOT_ONLY) {
      const home = await callJson(app, r.path, { method: r.method, host: a.host, token, body: r.body })
      expect(`${r.path} ${home.status}`).toBe(`${r.path} 404`)
      const root = await callJson(app, r.path, { method: r.method, host: ROOT, token, body: r.body })
      expect(`${r.path} ${root.status}`).toBe(`${r.path} ${r.onRoot}`)
    }
  })

  test("the owner cannot reach them from a tenant host either, and root still serves them", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    expect((await callJson(app, "/admin/settings", { host: a.host, token: owner.token })).status).toBe(404)
    expect((await callJson(app, "/admin/oauth/clients", { host: a.host, token: owner.token })).status).toBe(404)

    expect((await callJson(app, "/admin/settings", { host: ROOT, token: owner.token })).status).toBe(200)
    expect((await callJson(app, "/admin/oauth/clients", { host: ROOT, token: owner.token })).status).toBe(200)
    expect((await callJson(app, "/admin/mcp/servers", { host: ROOT, token: owner.token })).status).toBe(200)
    // federation is off by default: the gate answers, not a missing route
    expect((await callJson(app, "/me/federations", { host: ROOT, token: owner.token })).status).toBe(503)
    expect((await callJson(app, "/castle/health", { host: ROOT, token: CASTLE_TOKEN })).status).toBe(200)
  })
})

describe("castle provisioning stays inside the root team", () => {
  const provision = (host: string, body: Record<string, unknown>) =>
    callJson(app, "/castle/users", { method: "POST", host, token: CASTLE_TOKEN, body })
  const HASH = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$c29tZWhhc2g"

  test("new accounts land in root; a tenant's address is never touched", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const before = (await db.one(
      from("users")
        .where(q => q("id").equals(a.created.admin.id))
        .select("password", "team_id"),
    )) as { password: string; team_id: number }

    const made = await provision(ROOT, { email: "new@castle.test", username: "newbie", name: "New", password_hash: HASH })
    expect(made.status).toBe(201)
    const row = (await db.one(
      from("users")
        .where(q => q("id").equals(made.body.id))
        .select("team_id"),
    )) as { team_id: number }
    expect(Number(row.team_id)).toBe(1)

    // same email as the tenant admin: not an update of their account, not a duplicate
    const clash = await provision(ROOT, {
      email: a.created.admin.email,
      username: "whoever",
      name: "Clash",
      password_hash: HASH,
    })
    expect(clash.status).toBe(409)
    const after = (await db.one(
      from("users")
        .where(q => q("id").equals(a.created.admin.id))
        .select("password", "team_id"),
    )) as { password: string; team_id: number }
    expect(after).toEqual(before)

    const gone = await callJson(app, `/castle/users/by-email/${encodeURIComponent(a.created.admin.email)}`, {
      method: "DELETE",
      host: ROOT,
      token: CASTLE_TOKEN,
    })
    expect(gone.status).toBe(404)
    expect(await db.one(from("users").where(q => q("id").equals(a.created.admin.id)))).not.toBeNull()
  })
})

describe("per-user features stay available to tenants", () => {
  test("webhooks, actions and s3 keys answer on the tenant host", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    expect((await callJson(app, "/webhooks", { host: a.host, token: a.admin.token })).status).toBe(200)
    expect((await callJson(app, "/actions/registry", { host: a.host, token: a.admin.token })).status).toBe(200)
    expect((await callJson(app, "/me/s3-keys", { host: a.host, token: a.admin.token })).status).toBe(200)
    expect((await callJson(app, "/me/apps", { host: a.host, token: a.admin.token })).status).toBe(200)
  })
})

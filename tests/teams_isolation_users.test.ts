import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { buildApp, callJson } from "./helpers/http.ts"
import { threeTeams } from "./helpers/isolation.ts"
import { ROOT } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

// Every way one user can find, address or be told about another user must
// stop at the team boundary, and the answer for another team's user must be
// the answer for a user who does not exist.

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET, { rootDomain: ROOT })
})
beforeEach(async () => {
  await truncateAll()
})

describe("user lookup", () => {
  test("/users/search only returns the caller's team", async () => {
    const t = await threeTeams(app)
    const own = await callJson(app, "/users/search?q=mia", { host: t.acme.host, token: t.acme.admin.token })
    expect(own.status).toBe(200)
    expect(own.body.map((u: any) => u.username)).toEqual(["mia"])

    // "b" matches bea (beta) and rob (root) by substring; neither is visible from acme
    const other = await callJson(app, "/users/search?q=b", { host: t.acme.host, token: t.acme.admin.token })
    expect(other.status).toBe(200)
    expect(other.body).toEqual([])
    expect((await callJson(app, "/users/search?q=owner", { host: t.acme.host, token: t.acme.member.token })).body).toEqual([])

    // and the owner on root does not see tenants either
    expect((await callJson(app, "/users/search?q=mia", { host: ROOT, token: t.root.admin.token })).body).toEqual([])
  })

  test("/u/:username is 404 across teams, identical to a missing user", async () => {
    const t = await threeTeams(app)
    const own = await callJson(app, "/u/mia", { host: t.acme.host, token: t.acme.admin.token })
    expect(own.status).toBe(200)
    expect(own.body.username).toBe("mia")

    const missing = await callJson(app, "/u/nobody", { host: t.acme.host, token: t.acme.admin.token })
    for (const name of ["bea", "rob", "owner"]) {
      const res = await callJson(app, `/u/${name}`, { host: t.acme.host, token: t.acme.admin.token })
      expect(res.status).toBe(404)
      expect(res.body).toEqual(missing.body)
    }
  })
})

describe("messages", () => {
  test("a recipient in another team is not found, by username or id", async () => {
    const t = await threeTeams(app)
    const send = (body: Record<string, unknown>) =>
      callJson(app, "/me/messages", {
        method: "POST",
        host: t.acme.host,
        token: t.acme.member.token,
        body: { subject: "hi", body: "there", ...body },
      })
    const missing = await send({ username: "nobody" })
    expect(missing.status).toBe(404)
    for (const body of [
      { username: "bea" },
      { user_id: t.beta.member.id },
      { to_user_id: t.beta.admin.id },
      { username: "owner" },
      { user_id: t.root.member.id },
    ]) {
      const res = await send(body)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(missing.body)
    }
    // nothing landed anywhere
    const bea = await callJson(app, "/me/messages", { host: t.beta.host, token: t.beta.member.token })
    expect(bea.body.messages.filter((m: any) => m.kind === "user")).toHaveLength(0)

    // same team still works
    const ok = await send({ user_id: t.acme.admin.id })
    expect(ok.status).toBe(201)
    const inbox = await callJson(app, "/me/messages", { host: t.acme.host, token: t.acme.admin.token })
    expect(inbox.body.messages.some((m: any) => m.subject === "hi" && m.from.username === "mia")).toBe(true)
  })

  test("the owner's broadcast reaches one team: root by default, another by team_id", async () => {
    const t = await threeTeams(app)
    const recipients = async (subject: string) => {
      const rows = (await db.all(
        from("messages")
          .where(q => q("subject").equals(subject))
          .select("to_user_id"),
      )) as Array<{ to_user_id: number }>
      return rows.map(r => r.to_user_id).sort((a, b) => a - b)
    }

    const root = await callJson(app, "/admin/broadcast", {
      method: "POST",
      host: ROOT,
      token: t.root.admin.token,
      body: { subject: "to root", body: "hello" },
    })
    expect(root.status).toBe(201)
    expect(root.body.team_id).toBe(1)
    expect(root.body.delivered).toBe(2)
    expect(await recipients("to root")).toEqual([t.root.admin.id, t.root.member.id].sort((a, b) => a - b))

    const acme = await callJson(app, "/admin/broadcast", {
      method: "POST",
      host: ROOT,
      token: t.root.admin.token,
      body: { subject: "to acme", body: "hello", team_id: t.acme.teamId },
    })
    expect(acme.status).toBe(201)
    expect(acme.body.delivered).toBe(2)
    expect(await recipients("to acme")).toEqual([t.acme.admin.id, t.acme.member.id].sort((a, b) => a - b))

    // beta heard neither
    const bea = await callJson(app, "/me/messages", { host: t.beta.host, token: t.beta.member.token })
    expect(bea.body.messages.map((m: any) => m.subject)).not.toContain("to root")
    expect(bea.body.messages.map((m: any) => m.subject)).not.toContain("to acme")

    expect(
      (
        await callJson(app, "/admin/broadcast", {
          method: "POST",
          host: ROOT,
          token: t.root.admin.token,
          body: { subject: "x", body: "y", team_id: 9999 },
        })
      ).status,
    ).toBe(404)
    // a team admin has no broadcast at all
    expect(
      (
        await callJson(app, "/admin/broadcast", {
          method: "POST",
          host: t.acme.host,
          token: t.acme.admin.token,
          body: { subject: "x", body: "y" },
        })
      ).status,
    ).toBe(403)
  })
})

describe("invites", () => {
  test("a team's invite checks out on its own team host only", async () => {
    const t = await threeTeams(app)
    const inv = await callJson(app, "/invites", { method: "POST", host: t.acme.host, token: t.acme.admin.token, body: {} })
    expect(inv.status).toBe(201)
    expect((await callJson(app, `/invites/${inv.body.token}/check`, { host: t.beta.host })).status).toBe(404)
    expect((await callJson(app, `/invites/${inv.body.token}/check`, { host: ROOT })).status).toBe(404)
    expect((await callJson(app, `/invites/${inv.body.token}/check`, { host: t.acme.host })).status).toBe(200)
  })
})

describe("owner-only admin surfaces", () => {
  test("the content index status never opens from a tenant host, is_owner or not", async () => {
    const t = await threeTeams(app)
    expect((await callJson(app, "/admin/content-index/status", { host: ROOT, token: t.root.admin.token })).status).toBe(200)
    expect((await callJson(app, "/admin/content-index/status", { host: t.acme.host, token: t.acme.admin.token })).status).toBe(403)
    // a stray is_owner flag on a tenant account changes nothing
    await db.execute(
      from("users")
        .where(q => q("id").equals(t.acme.admin.id))
        .update({ is_owner: true }),
    )
    expect((await callJson(app, "/admin/content-index/status", { host: t.acme.host, token: t.acme.admin.token })).status).toBe(403)
  })

  test("the owner's audit and invite lists carry team_id and filter by it", async () => {
    const t = await threeTeams(app)
    const inv = await callJson(app, "/team/invites", {
      method: "POST",
      host: t.acme.host,
      token: t.acme.admin.token,
      body: { email: "new@acme.example" },
    })
    expect(inv.status).toBe(201)
    const invites = await callJson(app, "/admin/invites", { host: ROOT, token: t.root.admin.token })
    expect(invites.status).toBe(200)
    const mine = invites.body.find((i: any) => i.id === inv.body.id)
    expect(mine.team_id).toBe(t.acme.teamId)

    const all = await callJson(app, "/admin/audit", { host: ROOT, token: t.root.admin.token })
    expect(all.status).toBe(200)
    const teams = new Set(all.body.map((e: any) => e.team_id))
    expect(teams.has(1)).toBe(true)
    expect(teams.has(t.acme.teamId)).toBe(true)

    const acmeOnly = await callJson(app, `/admin/audit?team_id=${t.acme.teamId}`, { host: ROOT, token: t.root.admin.token })
    expect(acmeOnly.status).toBe(200)
    expect(acmeOnly.body.length).toBeGreaterThan(0)
    expect(acmeOnly.body.every((e: any) => e.team_id === t.acme.teamId)).toBe(true)
    expect(acmeOnly.body.map((e: any) => e.event)).toContain("team.user_created")
  })
})

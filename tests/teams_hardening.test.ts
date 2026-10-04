import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { countActiveTeamAdmins } from "../src/teams/members.ts"
import { teamBySlug } from "../src/teams/resolve.ts"
import { parseHost } from "../src/teams/slug.ts"
import { buildApp, callJson, fakeStore, resetSentEmails, sentEmails } from "./helpers/http.ts"
import { threeTeams } from "./helpers/isolation.ts"
import { callMultipart } from "./helpers/multipart.ts"
import { addMember, hostOf, login, ROOT, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET, { rootDomain: ROOT })
})
beforeEach(async () => {
  await truncateAll()
  resetSentEmails()
})

// logEvent is fire-and-forget; give the insert a moment to land
const auditEvents = async (host: string, token: string, event: string): Promise<any[]> => {
  for (let i = 0; i < 20; i++) {
    const res = await callJson(app, `/team/audit?event=${event}`, { host, token })
    if (res.status === 200 && res.body.length > 0) return res.body
    await new Promise(r => setTimeout(r, 25))
  }
  return []
}

// a team with two active admins, both signed in on its host
const twoAdmins = async (slug: string) => {
  const owner = await signupOwner(app)
  const a = await teamWithAdmin(app, owner, slug)
  const made = await callJson(app, "/team/users", {
    method: "POST",
    host: a.host,
    token: a.admin.token,
    body: { email: `two@${slug}.example`, username: "two", password: "password123", team_admin: true },
  })
  expect(made.status).toBe(201)
  const two = await login(app, a.host, `two@${slug}.example`)
  expect(two.status).toBe(200)
  return {
    owner,
    host: a.host,
    teamId: a.created.team.id,
    one: { id: a.created.admin.id, token: a.admin.token },
    two: { id: made.body.id as number, token: two.body.token as string },
  }
}

describe("uniqueness checks are not a cross-team oracle", () => {
  test("PATCH /me answers 422/401 before it ever looks the address up", async () => {
    const t = await threeTeams(app)
    const taken = "bea@member.example" // beta's member
    const attempt = (body: Record<string, unknown>) =>
      callJson(app, "/me", { method: "PATCH", host: t.acme.host, token: t.acme.member.token, body })

    expect((await attempt({ email: taken })).status).toBe(422)
    expect((await attempt({ username: "bea" })).status).toBe(422)
    expect((await attempt({ email: taken, current_password: "nope" })).status).toBe(401)
    // the right password still reaches the (legitimate) conflict
    expect((await attempt({ email: taken, current_password: "password123" })).status).toBe(409)
  })

  test("wrong-password guesses on PATCH /me are throttled before the lookup", async () => {
    const t = await threeTeams(app)
    const attempt = (pw: string) =>
      callJson(app, "/me", {
        method: "PATCH",
        host: t.acme.host,
        token: t.acme.member.token,
        body: { email: "bea@member.example", current_password: pw },
      })
    for (let i = 0; i < 10; i++) expect((await attempt("nope")).status).toBe(401)
    expect((await attempt("nope")).status).toBe(429)
    // even the right password is refused once the window is exhausted
    expect((await attempt("password123")).status).toBe(429)
  })

  test("a team admin's identity edits are bounded per actor and conflicts are audited", async () => {
    const t = await threeTeams(app)
    const probe = () =>
      callJson(app, `/team/users/${t.acme.member.id}`, {
        method: "PATCH",
        host: t.acme.host,
        token: t.acme.admin.token,
        body: { email: "bea@member.example" },
      })
    // threeTeams already spent one of the 30 creating mia through /team/users
    for (let i = 0; i < 29; i++) expect((await probe()).status).toBe(409)
    expect((await probe()).status).toBe(429)
    // the budget is shared with member creation
    const create = await callJson(app, "/team/users", {
      method: "POST",
      host: t.acme.host,
      token: t.acme.admin.token,
      body: { email: "fresh@acme.example", password: "password123" },
    })
    expect(create.status).toBe(429)
    // a name-only edit is not an identity lookup and still works
    const rename = await callJson(app, `/team/users/${t.acme.member.id}`, {
      method: "PATCH",
      host: t.acme.host,
      token: t.acme.admin.token,
      body: { name: "Mia R" },
    })
    expect(rename.status).toBe(200)

    const events = await auditEvents(t.acme.host, t.acme.admin.token, "admin.identity_conflict")
    expect(events.length).toBeGreaterThanOrEqual(29)
    const meta = JSON.parse(events[0].metadata)
    expect(meta.field).toBe("email")
    expect(meta.target).toBe(t.acme.member.id)
    expect(meta.actor).toBe("team_admin")
    // another admin's budget is untouched
    expect(
      (
        await callJson(app, `/team/users/${t.beta.member.id}`, {
          method: "PATCH",
          host: t.beta.host,
          token: t.beta.admin.token,
          body: { email: "mia@member.example" },
        })
      ).status,
    ).toBe(409)
  })

  test("member creation by a team admin audits the conflict", async () => {
    const t = await threeTeams(app)
    const res = await callJson(app, "/team/users", {
      method: "POST",
      host: t.acme.host,
      token: t.acme.admin.token,
      body: { email: "bea@member.example", password: "password123" },
    })
    expect(res.status).toBe(409)
    const events = await auditEvents(t.acme.host, t.acme.admin.token, "admin.identity_conflict")
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].metadata)).toEqual({ field: "email", target: null, actor: "team_admin" })
  })
})

describe("root.<ROOT_DOMAIN> is not the root team", () => {
  test("reserved labels parse as invalid and never resolve", async () => {
    expect(parseHost(`root.${ROOT}`, ROOT)).toEqual({ kind: "invalid" })
    expect(parseHost(`www.${ROOT}`, ROOT)).toEqual({ kind: "invalid" })
    expect(parseHost(`api.${ROOT}`, ROOT)).toEqual({ kind: "invalid" })
    expect(parseHost(`acme.${ROOT}`, ROOT)).toEqual({ kind: "team", slug: "acme" })
    expect(await teamBySlug(db, "root")).toBeNull()

    const owner = await signupOwner(app)
    const onRoot = await callJson(app, "/me", { host: hostOf("root"), token: owner.token })
    expect(onRoot.status).toBe(404)
    expect(onRoot.body.error).toBe("Unknown team")
    expect((await callJson(app, "/setup", { host: hostOf("root") })).status).toBe(404)
  })

  test("no certificate is allowed for it", async () => {
    await signupOwner(app)
    const ask = (domain: string) => callJson(app, `/internal/tls/allow?domain=${domain}`, { host: "api:3000", peer: "127.0.0.1" })
    expect((await ask(ROOT)).status).toBe(200)
    expect((await ask(hostOf("root"))).status).toBe(404)
    expect((await ask(hostOf("www"))).status).toBe(404)
  })
})

describe("/internal/tls/allow is rate-limited per asking peer", () => {
  test("60 asks a minute, then 429; another peer has its own budget", async () => {
    await signupOwner(app)
    const ask = (peer: string) => callJson(app, `/internal/tls/allow?domain=${hostOf("nobody")}`, { host: "api:3000", peer })
    for (let i = 0; i < 60; i++) expect((await ask("127.0.0.1")).status).toBe(404)
    const blocked = await ask("127.0.0.1")
    expect(blocked.status).toBe(429)
    expect(blocked.body.allow).toBe(false)
    expect(blocked.body.retry_after).toBeGreaterThan(0)
    expect((await ask("127.0.0.2")).status).toBe(404)
    // an untrusted peer is refused before it can spend anything
    expect((await ask("8.8.8.8")).status).toBe(403)
  })
})

describe("account deletion stays on the team host", () => {
  test("the cancel link carries the team's url and only restores there", async () => {
    const t = await threeTeams(app)
    const res = await callJson(app, "/me", {
      method: "DELETE",
      host: t.acme.host,
      token: t.acme.member.token,
      body: { password: "password123" },
    })
    expect(res.status).toBe(200)
    const mail = sentEmails.find(m => m.to === "mia@member.example")
    expect(mail?.html).toContain(`http://${t.acme.host}/account/restore?token=stohr_acd_`)
    const token = decodeURIComponent(mail?.html.match(/\/account\/restore\?token=([\w%-]+)/)?.[1] ?? "")
    expect(token.startsWith("stohr_acd_")).toBe(true)

    expect((await callJson(app, "/account/restore", { method: "POST", host: ROOT, body: { token } })).status).toBe(400)
    expect((await callJson(app, "/account/restore", { method: "POST", host: t.beta.host, body: { token } })).status).toBe(400)
    const back = await callJson(app, "/account/restore", { method: "POST", host: t.acme.host, body: { token } })
    expect(back.status).toBe(200)
    expect(back.body.user.id).toBe(t.acme.member.id)
    expect((await callJson(app, "/me", { host: t.acme.host, token: back.body.token })).status).toBe(200)
  })

  test("the root team's link is APP_URL as before", async () => {
    const owner = await signupOwner(app)
    await callJson(app, "/me", { method: "DELETE", host: ROOT, token: owner.token, body: { password: "password123" } })
    expect(sentEmails[0]?.html).toContain("http://test.local/account/restore?token=stohr_acd_")
  })
})

describe("/team/audit hides who the platform admin is", () => {
  test("the owner's actions on the team show as Platform admin with no identity or network details", async () => {
    const t = await threeTeams(app)
    const reset = await callJson(app, `/admin/users/${t.acme.member.id}/reset-password`, {
      method: "POST",
      host: ROOT,
      token: t.root.admin.token,
      body: {},
    })
    expect(reset.status).toBe(200)

    const masked = await auditEvents(t.acme.host, t.acme.admin.token, "admin.password_reset_issued")
    expect(masked).toHaveLength(1)
    expect(masked[0]).toMatchObject({
      actor: "Platform admin",
      user_id: null,
      username: null,
      user_email: null,
      ip: null,
      user_agent: null,
    })
    // the event itself, and what it did, is still there for the team
    expect(JSON.parse(masked[0].metadata).target).toBe(t.acme.member.id)

    // the team's own admin is shown as usual
    const own = await auditEvents(t.acme.host, t.acme.admin.token, "team.user_created")
    expect(own.length).toBeGreaterThan(0)
    expect(own[0].actor).toBeNull()
    expect(own[0].user_id).toBe(t.acme.admin.id)
    expect(own[0].username).toBe("admin")
    expect(own[0].user_email).toBe("admin@acme.example")

    // the owner's own view keeps the full row
    const full = await callJson(app, `/admin/audit?event=admin.password_reset_issued&team_id=${t.acme.teamId}`, {
      host: ROOT,
      token: t.root.admin.token,
    })
    expect(full.status).toBe(200)
    expect(full.body[0].user_id).toBe(t.root.admin.id)
    expect(full.body[0].username).toBe("owner")
  })
})

describe("comments on things you cannot see do not exist", () => {
  test("PATCH and DELETE are 404 across teams and for non-collaborators, 403 only when visible", async () => {
    const t = await threeTeams(app)
    const folder = await callJson(app, "/folders", {
      method: "POST",
      host: t.acme.host,
      token: t.acme.member.token,
      body: { name: "Notes" },
    })
    expect(folder.status).toBe(201)
    const comment = await callJson(app, `/folders/${folder.body.id}/comments`, {
      method: "POST",
      host: t.acme.host,
      token: t.acme.member.token,
      body: { body: "first" },
    })
    expect(comment.status).toBe(201)
    const id = comment.body.id as number

    const missing = await callJson(app, "/comments/999999", {
      method: "PATCH",
      host: t.beta.host,
      token: t.beta.member.token,
      body: { body: "x" },
    })
    expect(missing.status).toBe(404)

    for (const who of [
      { host: t.beta.host, token: t.beta.member.token }, // another team
      { host: ROOT, token: t.root.member.token }, // root member
      { host: t.acme.host, token: t.acme.admin.token }, // same team, no access to the folder
    ]) {
      const edit = await callJson(app, `/comments/${id}`, { method: "PATCH", ...who, body: { body: "x" } })
      expect(edit.status).toBe(404)
      expect(edit.body).toEqual(missing.body)
      const del = await callJson(app, `/comments/${id}`, { method: "DELETE", ...who })
      expect(del.status).toBe(404)
      expect(del.body).toEqual(missing.body)
    }

    // a viewer sees the comment: not theirs to edit, not theirs to remove
    const share = await callJson(app, `/folders/${folder.body.id}/collaborators`, {
      method: "POST",
      host: t.acme.host,
      token: t.acme.member.token,
      body: { identity: "admin", role: "viewer" },
    })
    expect([200, 201]).toContain(share.status)
    const asViewer = { host: t.acme.host, token: t.acme.admin.token }
    expect((await callJson(app, `/comments/${id}`, { method: "PATCH", ...asViewer, body: { body: "x" } })).status).toBe(403)
    expect((await callJson(app, `/comments/${id}`, { method: "DELETE", ...asViewer })).status).toBe(403)
    // the comment is untouched
    const list = await callJson(app, `/folders/${folder.body.id}/comments`, { host: t.acme.host, token: t.acme.member.token })
    expect(list.body.comments[0].body).toBe("first")
    expect(list.body.comments[0].deleted_at).toBeNull()
  })
})

describe("who mints invites", () => {
  test("root members still can; tenant members cannot; tenant admins can", async () => {
    const t = await threeTeams(app)
    expect((await callJson(app, "/invites", { method: "POST", host: ROOT, token: t.root.member.token, body: {} })).status).toBe(201)
    const refused = await callJson(app, "/invites", { method: "POST", host: t.acme.host, token: t.acme.member.token, body: {} })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe("Team admin access required")
    expect((await callJson(app, "/invites", { method: "POST", host: t.acme.host, token: t.acme.admin.token, body: {} })).status).toBe(201)
    // a member's list and revoke still work for whatever they hold
    expect((await callJson(app, "/invites", { host: t.acme.host, token: t.acme.member.token })).status).toBe(200)
  })
})

// Exactly one of the two racing requests may land. The loser is 422 when it
// lost inside the guard, or 401/403 when the winner's write (a revoked
// session, a lost role) had already landed by the time the loser was
// authenticated — both are the rule holding.
const oneWinner = (a: { status: number }, b: { status: number }, loser: number[]) => {
  const statuses = [a.status, b.status]
  expect(statuses.filter(s => s === 200)).toHaveLength(1)
  expect(loser).toContain(statuses.find(s => s !== 200))
}

describe("the last-admin rule holds under concurrency", () => {
  test("two admins demoting each other at once: exactly one succeeds", async () => {
    const team = await twoAdmins("acme")
    const demote = (target: number, token: string) =>
      callJson(app, `/team/users/${target}`, { method: "PATCH", host: team.host, token, body: { team_admin: false } })
    const [a, b] = await Promise.all([demote(team.one.id, team.two.token), demote(team.two.id, team.one.token)])
    oneWinner(a, b, [403, 422])
    expect(await countActiveTeamAdmins(db, team.teamId)).toBe(1)
  })

  test("two admins suspending each other at once: exactly one succeeds", async () => {
    const team = await twoAdmins("acme")
    const suspend = (target: number, token: string) =>
      callJson(app, `/team/users/${target}/suspend`, { method: "POST", host: team.host, token, body: {} })
    const [a, b] = await Promise.all([suspend(team.one.id, team.two.token), suspend(team.two.id, team.one.token)])
    oneWinner(a, b, [401, 403, 422])
    expect(await countActiveTeamAdmins(db, team.teamId)).toBe(1)
  })

  test("two admins deleting each other at once: exactly one is gone", async () => {
    const team = await twoAdmins("acme")
    const remove = (target: number, token: string) =>
      callJson(app, `/team/users/${target}`, { method: "DELETE", host: team.host, token })
    const [a, b] = await Promise.all([remove(team.one.id, team.two.token), remove(team.two.id, team.one.token)])
    oneWinner(a, b, [401, 403, 422])
    const left = (await db.all(
      from("users")
        .where(q => q("team_id").equals(team.teamId))
        .select("id"),
    )) as Array<{ id: number }>
    expect(left).toHaveLength(1)
    expect(await countActiveTeamAdmins(db, team.teamId)).toBe(1)
  })

  test("the serialized case still works: the first demotion lands, the second is refused", async () => {
    const team = await twoAdmins("acme")
    const first = await callJson(app, `/team/users/${team.one.id}`, {
      method: "PATCH",
      host: team.host,
      token: team.two.token,
      body: { team_admin: false },
    })
    expect(first.status).toBe(200)
    // `one` is no longer an admin, so cannot act; `two` cannot demote themself
    const self = await callJson(app, `/team/users/${team.two.id}`, {
      method: "PATCH",
      host: team.host,
      token: team.two.token,
      body: { team_admin: false },
    })
    expect(self.status).toBe(422)
  })
})

describe("DELETE /admin/users/:id purges", () => {
  test("rows cascade and blobs are dropped", async () => {
    const owner = await signupOwner(app)
    const rob = await addMember(app, ROOT, owner, "rob")
    const up = await callMultipart(app, "/files", {
      token: rob.token,
      host: ROOT,
      files: [{ name: "note.txt", type: "text/plain", body: "hello" }],
    })
    expect(up.status).toBe(201)
    const key = (await db.one(
      from("files")
        .where(q => q("id").equals(up.body[0].id))
        .select("storage_key"),
    )) as { storage_key: string }
    expect((await fakeStore.get(key.storage_key)).status).toBe(200)

    const gone = await callJson(app, `/admin/users/${rob.id}`, { method: "DELETE", host: ROOT, token: owner.token })
    expect(gone.status).toBe(200)
    expect(await db.one(from("users").where(q => q("id").equals(rob.id)))).toBeNull()
    expect(await db.one(from("files").where(q => q("id").equals(up.body[0].id)))).toBeNull()
    expect((await fakeStore.get(key.storage_key)).status).toBe(404)
    expect((await callJson(app, `/admin/users/${rob.id}`, { method: "DELETE", host: ROOT, token: owner.token })).status).toBe(404)
  })

  test("the owner cannot strand a tenant by deleting its last admin, but root's own admins are fine", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const last = await callJson(app, `/admin/users/${a.created.admin.id}`, { method: "DELETE", host: ROOT, token: owner.token })
    expect(last.status).toBe(422)
    expect(await db.one(from("users").where(q => q("id").equals(a.created.admin.id)))).not.toBeNull()

    // with a second admin in place the first can go
    const second = await callJson(app, "/team/users", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { email: "two@acme.example", username: "two", password: "password123", team_admin: true },
    })
    expect(second.status).toBe(201)
    expect((await callJson(app, `/admin/users/${a.created.admin.id}`, { method: "DELETE", host: ROOT, token: owner.token })).status).toBe(200)

    // the owner counts as root's admin, so root's only team_admin may be deleted
    const ra = await callJson(app, "/team/users", {
      method: "POST",
      host: ROOT,
      token: owner.token,
      body: { email: "ra@example.com", username: "rootadmin", password: "password123", team_admin: true },
    })
    expect(ra.status).toBe(201)
    expect((await callJson(app, `/admin/users/${ra.body.id}`, { method: "DELETE", host: ROOT, token: owner.token })).status).toBe(200)
  })
})

import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { buildApp, callJson, resetSentEmails, sentEmails } from "./helpers/http.ts"
import { addMember, createTeam, hostOf, login, ROOT, setPassword, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET, { rootDomain: ROOT })
})
beforeEach(async () => {
  await truncateAll()
  resetSentEmails()
})

describe("a credential only works on its own team's host", () => {
  test("session token from team A is rejected on root and on team B", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const b = await teamWithAdmin(app, owner, "beta")

    expect((await callJson(app, "/me", { host: a.host, token: a.admin.token })).status).toBe(200)
    expect((await callJson(app, "/me", { host: ROOT, token: a.admin.token })).status).toBe(401)
    expect((await callJson(app, "/me", { host: b.host, token: a.admin.token })).status).toBe(401)
    // and the owner's root session is nothing on a tenant host
    expect((await callJson(app, "/me", { host: a.host, token: owner.token })).status).toBe(401)
  })

  test("personal access token is pinned to its team too", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const pat = await callJson(app, "/me/apps", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { name: "cli" },
    })
    expect(pat.status).toBe(201)
    const token = pat.body.token as string
    expect((await callJson(app, "/me", { host: a.host, token })).status).toBe(200)
    expect((await callJson(app, "/me", { host: ROOT, token })).status).toBe(401)
  })

  test("GET /me carries the team, the admin flag and is_root", async () => {
    const owner = await signupOwner(app)
    const me = await callJson(app, "/me", { host: ROOT, token: owner.token })
    expect(me.body.team).toEqual({ id: 1, slug: "root", name: "Stohr" })
    expect(me.body.is_root).toBe(true)
    expect(me.body.team_admin).toBe(false)

    const a = await teamWithAdmin(app, owner, "acme")
    const adminMe = await callJson(app, "/me", { host: a.host, token: a.admin.token })
    expect(adminMe.body.team.slug).toBe("acme")
    expect(adminMe.body.team.id).toBe(a.created.team.id)
    expect(adminMe.body.is_root).toBe(false)
    expect(adminMe.body.team_admin).toBe(true)
    expect(adminMe.body.is_owner).toBe(false)
  })
})

describe("login is scoped to the host's team", () => {
  test("a user cannot log in on another team's host or on root", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const email = a.created.admin.email

    expect((await login(app, a.host, email)).status).toBe(200)
    const onRoot = await login(app, ROOT, email)
    expect(onRoot.status).toBe(401)
    expect(onRoot.body.error).toBe("Invalid credentials")
    const onOther = await login(app, hostOf("beta"), email)
    expect(onOther.status).toBe(404)

    // the owner can't log in on a tenant host either
    expect((await login(app, a.host, "owner@example.com")).status).toBe(401)
  })

  test("password reset only finds users of the host's team and links to that host", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    resetSentEmails()

    // asking on root for a tenant address: silent 200, no mail
    const cross = await callJson(app, "/password/forgot", {
      method: "POST",
      host: ROOT,
      body: { email: a.created.admin.email },
    })
    expect(cross.status).toBe(200)
    await Bun.sleep(50)
    expect(sentEmails).toHaveLength(0)

    const own = await callJson(app, "/password/forgot", {
      method: "POST",
      host: a.host,
      body: { email: a.created.admin.email },
    })
    expect(own.status).toBe(200)
    await Bun.sleep(50)
    expect(sentEmails).toHaveLength(1)
    const link = sentEmails[0]!.text.match(/https?:\/\/\S+/)?.[0] ?? ""
    expect(link.startsWith(`http://${a.host}/password/reset?token=`)).toBe(true)

    // the token redeems on its own host only
    const token = new URL(link).searchParams.get("token")!
    const wrongHost = await callJson(app, "/password/reset", {
      method: "POST",
      host: ROOT,
      body: { token, new_password: "newpassword1" },
    })
    expect(wrongHost.status).toBe(400)
    const rightHost = await callJson(app, "/password/reset", {
      method: "POST",
      host: a.host,
      body: { token, new_password: "newpassword1" },
    })
    expect(rightHost.status).toBe(200)
    expect((await login(app, a.host, a.created.admin.email, "newpassword1")).status).toBe(200)
  })

  test("the set-password link from team creation only works on the team host", async () => {
    const owner = await signupOwner(app)
    const made = await createTeam(app, owner, "acme")
    expect(made.set_password_url.startsWith(`http://${hostOf("acme")}/password/reset?token=`)).toBe(true)
    const token = new URL(made.set_password_url).searchParams.get("token")!
    const onRoot = await callJson(app, "/password/reset", {
      method: "POST",
      host: ROOT,
      body: { token, new_password: "password123" },
    })
    expect(onRoot.status).toBe(400)
    await setPassword(app, made)
  })
})

describe("signup and invites", () => {
  test("tenant hosts have no open signup, even with an invite from another team", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")

    const noInvite = await callJson(app, "/signup", {
      method: "POST",
      host: a.host,
      body: { username: "walkin", email: "walkin@x.test", password: "password123" },
    })
    expect(noInvite.status).toBe(403)

    // a root invite is not valid on the tenant host
    const rootInvite = await callJson(app, "/invites", { method: "POST", host: ROOT, token: owner.token, body: {} })
    expect(rootInvite.status).toBe(201)
    const wrongTeam = await callJson(app, "/signup", {
      method: "POST",
      host: a.host,
      body: { username: "walkin", email: "walkin@x.test", password: "password123", invite_token: rootInvite.body.token },
    })
    expect(wrongTeam.status).toBe(403)
    expect(wrongTeam.body.error).toBe("Invalid invite token")
  })

  test("a team invite redeems on the team host and the newcomer joins that team", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")

    const invite = await callJson(app, "/team/invites", { method: "POST", host: a.host, token: a.admin.token, body: {} })
    expect(invite.status).toBe(201)
    const token = invite.body.token as string

    // check is host-scoped
    expect((await callJson(app, `/invites/${token}/check`, { host: ROOT })).status).toBe(404)
    expect((await callJson(app, `/invites/${token}/check`, { host: a.host })).status).toBe(200)

    // the invite is useless on root
    const onRoot = await callJson(app, "/signup", {
      method: "POST",
      host: ROOT,
      body: { username: "newbie", email: "newbie@x.test", password: "password123", invite_token: token },
    })
    expect(onRoot.status).toBe(403)

    const joined = await callJson(app, "/signup", {
      method: "POST",
      host: a.host,
      body: { username: "newbie", email: "newbie@x.test", password: "password123", invite_token: token },
    })
    expect(joined.status).toBe(201)
    expect(joined.body.is_owner).toBe(false)
    const row = (await db.one(
      from("users")
        .where(q => q("id").equals(joined.body.id))
        .select("team_id"),
    )) as { team_id: number }
    expect(Number(row.team_id)).toBe(a.created.team.id)
    const me = await callJson(app, "/me", { host: a.host, token: joined.body.token })
    expect(me.body.team.slug).toBe("acme")
  })

  test("on a tenant host only the team admin mints invites, and they are bound to the team", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const member = await addMember(app, a.host, a.admin, "mia")
    const refused = await callJson(app, "/invites", { method: "POST", host: a.host, token: member.token, body: {} })
    expect(refused.status).toBe(403)
    const invite = await callJson(app, "/invites", { method: "POST", host: a.host, token: a.admin.token, body: {} })
    expect(invite.status).toBe(201)
    const row = (await db.one(
      from("invites")
        .where(q => q("id").equals(invite.body.id))
        .select("team_id"),
    )) as { team_id: number }
    expect(Number(row.team_id)).toBe(a.created.team.id)
  })
})

describe("root-only surfaces", () => {
  test("external login routes do not exist on a tenant host", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    expect((await callJson(app, "/auth/oidc/start", { host: a.host })).status).toBe(404)
    expect((await callJson(app, "/auth/ldap/login", { method: "POST", host: a.host, body: { identity: "x", password: "y" } })).status).toBe(404)
    const oidc = await callJson(app, "/auth/oidc/status", { host: a.host })
    expect(oidc.body.available).toBe(false)
    const ldap = await callJson(app, "/auth/ldap/status", { host: a.host })
    expect(ldap.body.available).toBe(false)
  })

  test("owner-only admin routes are refused on a tenant host even for the owner's token", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    expect((await callJson(app, "/admin/teams", { host: a.host, token: owner.token })).status).toBe(401)
    expect((await callJson(app, "/admin/users", { host: a.host, token: a.admin.token })).status).toBe(403)
  })

  test("oauth discovery issuer follows the team host", async () => {
    const owner = await signupOwner(app)
    await createTeam(app, owner, "acme")
    const root = await callJson(app, "/.well-known/oauth-authorization-server", { host: ROOT })
    expect(root.body.issuer).toBe("http://test.local")
    const team = await callJson(app, "/.well-known/oauth-authorization-server", { host: hostOf("acme") })
    expect(team.body.issuer).toBe(`http://${hostOf("acme")}`)
    expect(team.body.token_endpoint).toBe(`http://${hostOf("acme")}/oauth/token`)
  })
})

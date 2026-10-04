import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from, raw } from "@atlas/db"
import { sweepDeletedTeams } from "../src/teams/admin.ts"
import { buildApp, callJson, fakeStore } from "./helpers/http.ts"
import { callMultipart } from "./helpers/multipart.ts"
import { addMember, createTeam, hostOf, login, ROOT, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET, { rootDomain: ROOT })
})
beforeEach(async () => {
  await truncateAll()
})

describe("/admin/teams", () => {
  test("create returns the team, its admin and a set-password link; list and detail show usage", async () => {
    const owner = await signupOwner(app)
    const made = await createTeam(app, owner, "acme", { quota_bytes: 1024 })
    expect(made.team.slug).toBe("acme")
    expect(made.team.quota_bytes).toBe(1024)
    expect(made.admin.email).toBe("admin@acme.example")
    expect(made.admin.username).toBe("admin")
    expect(made.set_password_url).toContain(`http://${hostOf("acme")}/password/reset?token=`)

    const list = await callJson(app, "/admin/teams", { host: ROOT, token: owner.token })
    expect(list.status).toBe(200)
    expect(list.body.map((t: any) => t.slug)).toEqual(["root", "acme"])
    const acme = list.body.find((t: any) => t.slug === "acme")
    expect(acme.user_count).toBe(1)
    expect(acme.usage.total).toBe(0)
    expect(acme.base_url).toBe(`http://${hostOf("acme")}`)

    const detail = await callJson(app, `/admin/teams/${made.team.id}`, { host: ROOT, token: owner.token })
    expect(detail.status).toBe(200)
    expect(detail.body.name).toBe("ACME")
  })

  test("reserved, malformed and duplicate slugs are refused", async () => {
    const owner = await signupOwner(app)
    const attempt = (slug: string) =>
      callJson(app, "/admin/teams", {
        method: "POST",
        host: ROOT,
        token: owner.token,
        body: { slug, admin_email: `a@${slug}.example` },
      })
    for (const s of ["root", "www", "api", "admin", "app", "s3", "webdav"]) {
      const res = await attempt(s)
      expect(res.status).toBe(422)
      expect(res.body.error).toBe("slug is reserved")
    }
    expect((await attempt("-bad")).status).toBe(422)
    expect((await attempt("Bad")).status).toBe(201) // normalized to "bad"
    expect((await attempt("bad")).status).toBe(409)
  })

  test("a duplicate admin email rolls the team back", async () => {
    const owner = await signupOwner(app)
    const res = await callJson(app, "/admin/teams", {
      method: "POST",
      host: ROOT,
      token: owner.token,
      body: { slug: "acme", admin_email: "owner@example.com" },
    })
    expect(res.status).toBe(409)
    const row = await db.one(
      from("teams")
        .where(q => q("slug").equals("acme"))
        .select("id"),
    )
    expect(row).toBeNull()
  })

  test("only the owner, and only on root", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const asAdmin = await callJson(app, "/admin/teams", { host: a.host, token: a.admin.token })
    expect(asAdmin.status).toBe(403)
    // a root user who is not the owner
    const invite = await callJson(app, "/invites", { method: "POST", host: ROOT, token: owner.token, body: {} })
    const bob = await callJson(app, "/signup", {
      method: "POST",
      host: ROOT,
      body: { username: "bob", email: "bob@x.test", password: "password123", invite_token: invite.body.token },
    })
    expect((await callJson(app, "/admin/teams", { host: ROOT, token: bob.body.token })).status).toBe(403)
  })

  test("patch edits name and quota; root cannot be suspended or deleted", async () => {
    const owner = await signupOwner(app)
    const made = await createTeam(app, owner, "acme")
    const upd = await callJson(app, `/admin/teams/${made.team.id}`, {
      method: "PATCH",
      host: ROOT,
      token: owner.token,
      body: { name: "Acme Inc", quota_bytes: 5000 },
    })
    expect(upd.status).toBe(200)
    expect(upd.body.name).toBe("Acme Inc")
    expect(upd.body.quota_bytes).toBe(5000)
    const unlimited = await callJson(app, `/admin/teams/${made.team.id}`, {
      method: "PATCH",
      host: ROOT,
      token: owner.token,
      body: { quota_bytes: null },
    })
    expect(unlimited.body.quota_bytes).toBeNull()

    expect(
      (await callJson(app, "/admin/teams/1", { method: "PATCH", host: ROOT, token: owner.token, body: { suspended: true } }))
        .status,
    ).toBe(422)
    expect((await callJson(app, "/admin/teams/1", { method: "DELETE", host: ROOT, token: owner.token })).status).toBe(422)
    // the owner may rename root
    const renamed = await callJson(app, "/admin/teams/1", {
      method: "PATCH",
      host: ROOT,
      token: owner.token,
      body: { name: "HQ" },
    })
    expect(renamed.status).toBe(200)
    const me = await callJson(app, "/me", { host: ROOT, token: owner.token })
    expect(me.body.team.name).toBe("HQ")
  })

  test("the owner can reset a tenant user's password and the link lands on the team host", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const res = await callJson(app, `/admin/users/${a.created.admin.id}/reset-password`, {
      method: "POST",
      host: ROOT,
      token: owner.token,
      body: {},
    })
    expect(res.status).toBe(200)
    expect(res.body.emailed).toBe(true)
    const detail = await callJson(app, `/admin/users/${a.created.admin.id}`, { host: ROOT, token: owner.token })
    expect(detail.status).toBe(200)
    expect(detail.body.team_id).toBe(a.created.team.id)
    expect(detail.body.team_admin).toBe(true)
  })

  test("a tenant user cannot be made owner", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const res = await callJson(app, `/admin/users/${a.created.admin.id}/owner`, {
      method: "POST",
      host: ROOT,
      token: owner.token,
      body: { is_owner: true },
    })
    expect(res.status).toBe(422)
  })

  test("purge sweep removes members, their blobs and the team after the grace window", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const up = await callMultipart(app, "/files", {
      token: a.admin.token,
      host: a.host,
      files: [{ name: "note.txt", type: "text/plain", body: "hello" }],
    })
    expect(up.status).toBe(201)
    const fileId = up.body[0].id as number
    const key = (await db.one(
      from("files")
        .where(q => q("id").equals(fileId))
        .select("storage_key"),
    )) as { storage_key: string }
    expect((await fakeStore.get(key.storage_key)).status).toBe(200)

    expect((await callJson(app, `/admin/teams/${a.created.team.id}`, { method: "DELETE", host: ROOT, token: owner.token })).status).toBe(200)
    // still inside the window: nothing is purged
    await sweepDeletedTeams(db, fakeStore)
    expect(await db.one(from("teams").where(q => q("id").equals(a.created.team.id)))).not.toBeNull()

    await db.execute(
      from("teams")
        .where(q => q("id").equals(a.created.team.id))
        .update({ deleted_at: raw("NOW() - INTERVAL '25 hours'") }),
    )
    await sweepDeletedTeams(db, fakeStore)
    expect(await db.one(from("teams").where(q => q("id").equals(a.created.team.id)))).toBeNull()
    expect(await db.one(from("users").where(q => q("id").equals(a.created.admin.id)))).toBeNull()
    expect((await fakeStore.get(key.storage_key)).status).toBe(404)
    // the slug is free again
    expect((await createTeam(app, owner, "acme")).team.slug).toBe("acme")
  })
})

describe("/team (team admin)", () => {
  test("GET /team shows own quota and usage; members are refused", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme", { quota_bytes: 4096 })
    const t = await callJson(app, "/team", { host: a.host, token: a.admin.token })
    expect(t.status).toBe(200)
    expect(t.body.slug).toBe("acme")
    expect(t.body.quota_bytes).toBe(4096)
    expect(t.body.user_count).toBe(1)
    expect(t.body.usage.total).toBe(0)

    const member = await addMember(app, a.host, a.admin, "mia")
    expect((await callJson(app, "/team", { host: a.host, token: member.token })).status).toBe(403)
    expect((await callJson(app, "/team/users", { host: a.host, token: member.token })).status).toBe(403)
  })

  test("the owner is a team admin of root on the root host", async () => {
    const owner = await signupOwner(app)
    const t = await callJson(app, "/team", { host: ROOT, token: owner.token })
    expect(t.status).toBe(200)
    expect(t.body.slug).toBe("root")
    const users = await callJson(app, "/team/users", { host: ROOT, token: owner.token })
    expect(users.status).toBe(200)
    expect(users.body).toHaveLength(1)
  })

  test("a team admin never sees, edits or suspends users of another team", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const b = await teamWithAdmin(app, owner, "beta")
    const bMember = await addMember(app, b.host, b.admin, "bea")

    const listA = await callJson(app, "/team/users", { host: a.host, token: a.admin.token })
    expect(listA.body.map((u: any) => u.id)).toEqual([a.created.admin.id])

    for (const target of [bMember.id, b.created.admin.id, owner.id]) {
      expect((await callJson(app, `/team/users/${target}`, { host: a.host, token: a.admin.token })).status).toBe(404)
      expect(
        (await callJson(app, `/team/users/${target}`, { method: "PATCH", host: a.host, token: a.admin.token, body: { name: "x" } }))
          .status,
      ).toBe(404)
      expect(
        (await callJson(app, `/team/users/${target}/suspend`, { method: "POST", host: a.host, token: a.admin.token, body: {} }))
          .status,
      ).toBe(404)
      expect(
        (await callJson(app, `/team/users/${target}/reset-password`, { method: "POST", host: a.host, token: a.admin.token, body: {} }))
          .status,
      ).toBe(404)
    }
    // team b is untouched
    expect((await callJson(app, "/me", { host: b.host, token: bMember.token })).status).toBe(200)
  })

  test("team admins manage their own members: create, promote, suspend, reset, delete", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")

    // created without a password → set-password link on the team host
    const made = await callJson(app, "/team/users", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { email: "sam@acme.example", name: "Sam" },
    })
    expect(made.status).toBe(201)
    expect(made.body.team_id).toBe(a.created.team.id)
    expect(made.body.set_password_url).toContain(`http://${a.host}/password/reset?token=`)
    const samId = made.body.id as number

    // is_owner is not a thing here; team_admin is
    const promote = await callJson(app, `/team/users/${samId}`, {
      method: "PATCH",
      host: a.host,
      token: a.admin.token,
      body: { team_admin: true, is_owner: true },
    })
    expect(promote.status).toBe(200)
    expect(promote.body.updated).toEqual(["team_admin"])
    const row = (await db.one(
      from("users")
        .where(q => q("id").equals(samId))
        .select("is_owner", "team_admin"),
    )) as { is_owner: boolean; team_admin: boolean }
    expect(row.is_owner).toBe(false)
    expect(row.team_admin).toBe(true)

    // sam sets a password via the link and signs in on the team host
    const token = new URL(made.body.set_password_url).searchParams.get("token")!
    expect(
      (await callJson(app, "/password/reset", { method: "POST", host: a.host, body: { token, new_password: "password123" } }))
        .status,
    ).toBe(200)
    const sam = await login(app, a.host, "sam@acme.example")
    expect(sam.status).toBe(200)

    const suspend = await callJson(app, `/team/users/${samId}/suspend`, {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { reason: "vacation" },
    })
    expect(suspend.status).toBe(200)
    expect((await callJson(app, "/me", { host: a.host, token: sam.body.token })).status).toBe(401)
    expect(
      (await callJson(app, `/team/users/${samId}/unsuspend`, { method: "POST", host: a.host, token: a.admin.token, body: {} }))
        .status,
    ).toBe(200)

    const reset = await callJson(app, `/team/users/${samId}/reset-password`, {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: {},
    })
    expect(reset.status).toBe(200)

    const audit = await callJson(app, "/team/audit", { host: a.host, token: a.admin.token })
    expect(audit.status).toBe(200)
    const events = audit.body.map((e: any) => e.event)
    expect(events).toContain("team.user_created")
    expect(events).toContain("admin.user_suspended")
    // nothing from root leaks in
    expect(events).not.toContain("admin.team_created")

    const gone = await callJson(app, `/team/users/${samId}`, { method: "DELETE", host: a.host, token: a.admin.token })
    expect(gone.status).toBe(200)
    expect(await db.one(from("users").where(q => q("id").equals(samId)))).toBeNull()
  })

  test("the last active team admin cannot be demoted, suspended or deleted", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const adminId = a.created.admin.id
    const self = await callJson(app, `/team/users/${adminId}`, {
      method: "PATCH",
      host: a.host,
      token: a.admin.token,
      body: { team_admin: false },
    })
    expect(self.status).toBe(422)

    // a second admin can act on the first, but not remove the last one standing
    const made = await callJson(app, "/team/users", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { email: "two@acme.example", username: "two", password: "password123", team_admin: true },
    })
    expect(made.status).toBe(201)
    const two = await login(app, a.host, "two@acme.example")
    const demote = await callJson(app, `/team/users/${adminId}`, {
      method: "PATCH",
      host: a.host,
      token: two.body.token,
      body: { team_admin: false },
    })
    expect(demote.status).toBe(200)
    expect(
      (await callJson(app, `/team/users/${made.body.id}/suspend`, { method: "POST", host: a.host, token: two.body.token, body: {} }))
        .status,
    ).toBe(422) // cannot suspend yourself anyway
    // and now `two` is the last admin: the (demoted) first admin can't act, the owner can't demote two via /team on root
    expect((await callJson(app, "/team/users", { host: a.host, token: a.admin.token })).status).toBe(403)
  })

  test("a root team admin cannot touch the owner", async () => {
    const owner = await signupOwner(app)
    const made = await callJson(app, "/team/users", {
      method: "POST",
      host: ROOT,
      token: owner.token,
      body: { email: "ra@example.com", username: "rootadmin", password: "password123", team_admin: true },
    })
    expect(made.status).toBe(201)
    const ra = await login(app, ROOT, "ra@example.com")
    expect(
      (await callJson(app, `/team/users/${owner.id}`, { method: "PATCH", host: ROOT, token: ra.body.token, body: { name: "pwn" } }))
        .status,
    ).toBe(403)
    expect(
      (await callJson(app, `/team/users/${owner.id}/suspend`, { method: "POST", host: ROOT, token: ra.body.token, body: {} }))
        .status,
    ).toBe(422)
    expect((await callJson(app, "/admin/teams", { host: ROOT, token: ra.body.token })).status).toBe(403)
  })

  test("team invites are listed and revoked within the team only", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const b = await teamWithAdmin(app, owner, "beta")
    const inv = await callJson(app, "/team/invites", { method: "POST", host: a.host, token: a.admin.token, body: { email: "x@acme.example" } })
    expect(inv.status).toBe(201)
    const listB = await callJson(app, "/team/invites", { host: b.host, token: b.admin.token })
    expect(listB.body).toHaveLength(0)
    expect((await callJson(app, `/team/invites/${inv.body.id}`, { method: "DELETE", host: b.host, token: b.admin.token })).status).toBe(404)
    expect((await callJson(app, `/team/invites/${inv.body.id}`, { method: "DELETE", host: a.host, token: a.admin.token })).status).toBe(200)
  })
})

describe("team quota", () => {
  test("the team cap applies across members on top of the per-user cap", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme", { quota_bytes: 10 })
    const mia = await addMember(app, a.host, a.admin, "mia")

    const first = await callMultipart(app, "/files", {
      token: a.admin.token,
      host: a.host,
      files: [{ name: "a.txt", type: "text/plain", body: "123456" }],
    })
    expect(first.status).toBe(201)

    // a different member pushes the team over the line
    const second = await callMultipart(app, "/files", {
      token: mia.token,
      host: a.host,
      files: [{ name: "b.txt", type: "text/plain", body: "12345" }],
    })
    expect(second.status).toBe(402)
    expect(second.body.scope).toBe("team")
    expect(second.body.quota_bytes).toBe(10)
    expect(second.body.used_bytes).toBe(6)

    const team = await callJson(app, "/team", { host: a.host, token: a.admin.token })
    expect(team.body.usage.total).toBe(6)

    // lifting the cap lets it through
    await callJson(app, `/admin/teams/${a.created.team.id}`, {
      method: "PATCH",
      host: ROOT,
      token: owner.token,
      body: { quota_bytes: null },
    })
    const third = await callMultipart(app, "/files", {
      token: mia.token,
      host: a.host,
      files: [{ name: "b.txt", type: "text/plain", body: "12345" }],
    })
    expect(third.status).toBe(201)
  })

  test("root team is unlimited by default", async () => {
    const owner = await signupOwner(app)
    const up = await callMultipart(app, "/files", {
      token: owner.token,
      host: ROOT,
      files: [{ name: "big.txt", type: "text/plain", body: "x".repeat(5000) }],
    })
    expect(up.status).toBe(201)
  })
})

describe("/internal/tls/allow", () => {
  test("loopback peer only; 200 for root domain and live teams, 404 otherwise", async () => {
    const owner = await signupOwner(app)
    const made = await createTeam(app, owner, "acme")
    const ask = (domain: string, peer = "127.0.0.1") =>
      callJson(app, `/internal/tls/allow?domain=${domain}`, { host: "web:3001", peer })

    expect((await ask(ROOT)).status).toBe(200)
    expect((await ask("test.local")).status).toBe(200) // APP_URL host
    expect((await ask(hostOf("acme"))).status).toBe(200)
    expect((await ask(hostOf("ACME"))).status).toBe(200)
    expect((await ask(hostOf("nobody"))).status).toBe(404)
    expect((await ask("evil.example")).status).toBe(404)
    expect((await ask("a.b.stohr.test")).status).toBe(404)
    expect((await ask(hostOf("acme"), "8.8.8.8")).status).toBe(403)
    expect((await callJson(app, "/internal/tls/allow", { host: "web:3001", peer: "127.0.0.1" })).status).toBe(400)

    await callJson(app, `/admin/teams/${made.team.id}`, { method: "DELETE", host: ROOT, token: owner.token })
    expect((await ask(hostOf("acme"))).status).toBe(404)
  })
})

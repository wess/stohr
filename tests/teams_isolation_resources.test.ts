import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from, raw } from "@atlas/db"
import { resolvePendingCollabs } from "../src/auth/index.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { threeTeams } from "./helpers/isolation.ts"
import { callMultipart } from "./helpers/multipart.ts"
import { ROOT } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

// A folder, file, share, comment or collaboration that belongs to another
// team's user does not exist for the caller, however they got its id. The
// check lives in fileAccess/folderAccess so every route inherits it; these
// tests walk the routes to prove that.

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET, { rootDomain: ROOT })
})
beforeEach(async () => {
  await truncateAll()
})

// acme's admin owns a folder with one file in it
const seedAcme = async (t: Awaited<ReturnType<typeof threeTeams>>) => {
  const folder = await callJson(app, "/folders", {
    method: "POST",
    host: t.acme.host,
    token: t.acme.admin.token,
    body: { name: "Quarterly" },
  })
  expect(folder.status).toBe(201)
  const up = await callMultipart(app, "/files", {
    token: t.acme.admin.token,
    host: t.acme.host,
    fields: { folder_id: String(folder.body.id) },
    files: [{ name: "quarterly-report.txt", type: "text/plain", body: "zebra budget numbers" }],
  })
  expect(up.status).toBe(201)
  return { folderId: folder.body.id as number, fileId: up.body[0].id as number }
}

describe("guessed ids from another team", () => {
  test("every file and folder route answers 404", async () => {
    const t = await threeTeams(app)
    const { folderId, fileId } = await seedAcme(t)
    const bea = { host: t.beta.host, token: t.beta.member.token }
    const owner = { host: ROOT, token: t.root.admin.token }

    const reads = [
      `/files/${fileId}`,
      `/files/${fileId}/download`,
      `/files/${fileId}/thumb`,
      `/files/${fileId}/versions`,
      `/files/${fileId}/versions/1/download`,
      `/files/${fileId}/comments`,
      `/files/${fileId}/activity`,
      `/files/${fileId}/collaborators`,
      `/files?folder_id=${folderId}`,
      `/folders/${folderId}`,
      `/folders?parent_id=${folderId}`,
      `/folders/${folderId}/comments`,
      `/folders/${folderId}/activity`,
      `/folders/${folderId}/collaborators`,
    ]
    for (const path of reads) {
      expect((await callJson(app, path, bea)).status).toBe(404)
      // the instance owner is a root user, not a member of acme
      expect((await callJson(app, path, owner)).status).toBe(404)
    }

    const writes: Array<[string, string, unknown]> = [
      ["PATCH", `/files/${fileId}`, { name: "renamed.txt" }],
      ["DELETE", `/files/${fileId}`, undefined],
      ["POST", `/files/${fileId}/comments`, { body: "hello" }],
      ["POST", `/files/${fileId}/collaborators`, { identity: "bea" }],
      ["DELETE", `/files/${fileId}/collaborators/1`, undefined],
      ["POST", `/files/${fileId}/versions/1/restore`, undefined],
      ["DELETE", `/files/${fileId}/versions/1`, undefined],
      ["POST", `/shares`, { file_id: fileId, expires_in: 60 }],
      ["PATCH", `/folders/${folderId}`, { name: "renamed" }],
      ["DELETE", `/folders/${folderId}`, undefined],
      ["POST", `/folders`, { name: "child", parent_id: folderId }],
      ["POST", `/folders/${folderId}/comments`, { body: "hello" }],
      ["POST", `/folders/${folderId}/collaborators`, { identity: "bea" }],
      ["DELETE", `/folders/${folderId}/collaborators/1`, undefined],
    ]
    for (const [method, path, body] of writes) {
      const res = await callJson(app, path, { ...bea, method: method as any, body })
      expect(res.status).toBe(404)
    }
    const up = await callMultipart(app, "/files", {
      token: bea.token,
      host: bea.host,
      fields: { folder_id: String(folderId) },
      files: [{ name: "x.txt", type: "text/plain", body: "x" }],
    })
    expect(up.status).toBe(404)

    // untouched
    const still = await callJson(app, `/files/${fileId}`, { host: t.acme.host, token: t.acme.admin.token })
    expect(still.status).toBe(200)
    expect(still.body.name).toBe("quarterly-report.txt")
  })

  test("trash: restore and purge are 404, the listing stays personal", async () => {
    const t = await threeTeams(app)
    const { folderId, fileId } = await seedAcme(t)
    expect((await callJson(app, `/files/${fileId}`, { method: "DELETE", host: t.acme.host, token: t.acme.admin.token })).status).toBe(200)
    expect((await callJson(app, `/folders/${folderId}`, { method: "DELETE", host: t.acme.host, token: t.acme.admin.token })).status).toBe(200)

    const bea = { host: t.beta.host, token: t.beta.member.token }
    expect((await callJson(app, `/files/${fileId}/restore`, { ...bea, method: "POST" })).status).toBe(404)
    expect((await callJson(app, `/files/${fileId}/purge`, { ...bea, method: "DELETE" })).status).toBe(404)
    expect((await callJson(app, `/folders/${folderId}/restore`, { ...bea, method: "POST" })).status).toBe(404)
    expect((await callJson(app, `/folders/${folderId}/purge`, { ...bea, method: "DELETE" })).status).toBe(404)
    const trash = await callJson(app, "/trash", bea)
    expect(trash.body).toEqual({ folders: [], files: [] })

    // and the owner still can
    expect((await callJson(app, `/folders/${folderId}/restore`, { method: "POST", host: t.acme.host, token: t.acme.admin.token })).status).toBe(200)
    expect((await callJson(app, `/files/${fileId}/restore`, { method: "POST", host: t.acme.host, token: t.acme.admin.token })).status).toBe(200)
  })
})

describe("collaborators", () => {
  test("targets resolve inside the team; another team's user looks unregistered", async () => {
    const t = await threeTeams(app)
    const { folderId } = await seedAcme(t)
    const add = (identity: string) =>
      callJson(app, `/folders/${folderId}/collaborators`, {
        method: "POST",
        host: t.acme.host,
        token: t.acme.admin.token,
        body: { identity, role: "editor" },
      })

    const missing = await add("nobody")
    expect(missing.status).toBe(404)
    for (const name of ["bea", "rob", "owner"]) {
      const res = await add(name)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(missing.body)
    }

    // an email that belongs to a beta account is treated like any unknown
    // address: a pending grant plus an invite for acme, no user attached
    const byEmail = await add("bea@member.example")
    expect(byEmail.status).toBe(201)
    expect(byEmail.body.user).toBeNull()
    expect(byEmail.body.user_id).toBeNull()
    expect(byEmail.body.email).toBe("bea@member.example")
    const invite = (await db.one(
      from("invites")
        .where(q => q("email").equals("bea@member.example"))
        .select("team_id"),
    )) as { team_id: number }
    expect(invite.team_id).toBe(t.acme.teamId)

    // bea sees nothing of it
    const shared = await callJson(app, "/shared", { host: t.beta.host, token: t.beta.member.token })
    expect(shared.body).toEqual({ folders: [], files: [] })
    expect((await callJson(app, `/folders/${folderId}`, { host: t.beta.host, token: t.beta.member.token })).status).toBe(404)

    // same team works end to end
    const mia = await add("mia")
    expect(mia.status).toBe(201)
    expect(mia.body.user.id).toBe(t.acme.member.id)
    const seen = await callJson(app, `/folders/${folderId}`, { host: t.acme.host, token: t.acme.member.token })
    expect(seen.status).toBe(200)
    expect(seen.body.role).toBe("editor")
    const list = await callJson(app, `/folders/${folderId}/collaborators`, { host: t.acme.host, token: t.acme.admin.token })
    expect(list.body.map((r: any) => r.user?.username ?? r.email).sort()).toEqual(["bea@member.example", "mia"])
  })

  test("a pending email grant binds only to an account in the inviter's team", async () => {
    const t = await threeTeams(app)
    const { folderId } = await seedAcme(t)
    const pending = async (email: string) => {
      await db.execute(
        from("collaborations").insert({
          resource_type: "folder",
          resource_id: folderId,
          user_id: null,
          email,
          role: "viewer",
          invited_by: t.acme.admin.id,
        }),
      )
    }
    const row = async (email: string) =>
      (await db.one(
        from("collaborations")
          .where(q => q("resource_id").equals(folderId))
          .where(q => q.or(q("email").equals(email), q("user_id").isNotNull()))
          .select("user_id", "email"),
      )) as { user_id: number | null; email: string | null }

    await pending("bea@member.example")
    await resolvePendingCollabs(db, t.beta.member.id, "bea@member.example")
    expect(await row("bea@member.example")).toEqual({ user_id: null, email: "bea@member.example" })

    await pending("mia@member.example")
    await resolvePendingCollabs(db, t.acme.member.id, "mia@member.example")
    const bound = (await db.one(
      from("collaborations")
        .where(q => q("resource_id").equals(folderId))
        .where(q => q("user_id").equals(t.acme.member.id))
        .select("email"),
    )) as { email: string | null } | null
    expect(bound).toEqual({ email: null })
  })

  test("a stray cross-team grant row grants nothing and lists nothing", async () => {
    const t = await threeTeams(app)
    const { folderId, fileId } = await seedAcme(t)
    // the kind of row the team-scoped resolver can no longer create
    await db.execute(
      from("collaborations").insert({
        resource_type: "folder",
        resource_id: folderId,
        user_id: t.beta.member.id,
        email: null,
        role: "editor",
        invited_by: t.acme.admin.id,
        accepted_at: raw("NOW()"),
      }),
    )
    const bea = { host: t.beta.host, token: t.beta.member.token }
    expect((await callJson(app, `/folders/${folderId}`, bea)).status).toBe(404)
    expect((await callJson(app, `/files/${fileId}`, bea)).status).toBe(404)
    expect((await callJson(app, `/files/${fileId}/download`, bea)).status).toBe(404)
    expect((await callJson(app, "/shared", bea)).body).toEqual({ folders: [], files: [] })
    const search = await callJson(app, "/search?q=quarterly", bea)
    expect(search.body).toEqual({ files: [], folders: [] })
    const content = await callJson(app, "/search/content?q=zebra", bea)
    expect(content.body.files).toEqual([])
  })
})

describe("search", () => {
  test("name and content search never surface another team's rows", async () => {
    const t = await threeTeams(app)
    const { fileId } = await seedAcme(t)
    // the indexer runs out of band; mark the file indexed by hand
    await db.execute(
      from("files")
        .where(q => q("id").equals(fileId))
        .update({ text_content: "zebra budget numbers", text_indexed_version: 1, text_indexed_at: raw("NOW()") }),
    )

    const own = await callJson(app, "/search?q=quarterly", { host: t.acme.host, token: t.acme.admin.token })
    expect(own.body.files.map((f: any) => f.id)).toEqual([fileId])
    expect(own.body.folders).toHaveLength(1)
    const ownContent = await callJson(app, "/search/content?q=zebra", { host: t.acme.host, token: t.acme.admin.token })
    expect(ownContent.body.files.map((f: any) => f.id)).toEqual([fileId])

    for (const who of [
      { host: t.beta.host, token: t.beta.member.token },
      { host: t.beta.host, token: t.beta.admin.token },
      { host: ROOT, token: t.root.admin.token },
    ]) {
      expect((await callJson(app, "/search?q=quarterly", who)).body).toEqual({ files: [], folders: [] })
      expect((await callJson(app, "/search?q=.txt", who)).body.files).toEqual([])
      expect((await callJson(app, "/search/content?q=zebra", who)).body.files).toEqual([])
      expect((await callJson(app, "/files?q=quarterly", who)).body).toEqual([])
    }
  })
})

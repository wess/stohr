import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { buildApp, callJson } from "./helpers/http.ts"
import { threeTeams } from "./helpers/isolation.ts"
import { callMultipart } from "./helpers/multipart.ts"
import { ROOT } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

// A space belongs to its owner's team. Members come from that team only, and
// a space id from another team is not found — never forbidden, which would
// confirm it exists.

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET, { rootDomain: ROOT })
})
beforeEach(async () => {
  await truncateAll()
})

const acmeSpace = async (t: Awaited<ReturnType<typeof threeTeams>>) => {
  const made = await callJson(app, "/spaces", {
    method: "POST",
    host: t.acme.host,
    token: t.acme.admin.token,
    body: { name: "Acme Space" },
  })
  expect(made.status).toBe(201)
  return made.body.id as number
}

describe("space members", () => {
  test("users of another team cannot be added, by id, username or email", async () => {
    const t = await threeTeams(app)
    const spaceId = await acmeSpace(t)
    const add = (body: Record<string, unknown>) =>
      callJson(app, `/spaces/${spaceId}/members`, {
        method: "POST",
        host: t.acme.host,
        token: t.acme.admin.token,
        body: { role: "editor", ...body },
      })
    const missing = await add({ username: "nobody" })
    expect(missing.status).toBe(404)
    for (const body of [
      { username: "bea" },
      { user_id: t.beta.member.id },
      { userId: t.beta.admin.id },
      { email: "bea@member.example" },
      { username: "owner" },
      { user_id: t.root.member.id },
    ]) {
      const res = await add(body)
      expect(res.status).toBe(404)
      expect(res.body).toEqual(missing.body)
    }
    const members = await callJson(app, `/spaces/${spaceId}/members`, { host: t.acme.host, token: t.acme.admin.token })
    expect(members.body.members.map((m: any) => m.user.username)).toEqual(["admin"])

    const ok = await add({ username: "mia" })
    expect(ok.status).toBe(201)
    expect(ok.body.user.id).toBe(t.acme.member.id)
    const list = await callJson(app, "/spaces", { host: t.acme.host, token: t.acme.member.token })
    expect(list.body.spaces.map((s: any) => s.id)).toEqual([spaceId])
  })

  test("a space from another team is not found on every route", async () => {
    const t = await threeTeams(app)
    const spaceId = await acmeSpace(t)
    const folder = await callJson(app, `/spaces/${spaceId}/folders`, {
      method: "POST",
      host: t.acme.host,
      token: t.acme.admin.token,
      body: { name: "Shared" },
    })
    expect(folder.status).toBe(201)
    const memberRow = (await db.one(
      from("space_members")
        .where(q => q("space_id").equals(spaceId))
        .select("id"),
    )) as { id: number }

    for (const who of [
      { host: t.beta.host, token: t.beta.admin.token },
      { host: t.beta.host, token: t.beta.member.token },
      { host: ROOT, token: t.root.admin.token },
    ]) {
      expect((await callJson(app, `/spaces/${spaceId}`, who)).status).toBe(404)
      expect((await callJson(app, `/spaces/${spaceId}/members`, who)).status).toBe(404)
      expect((await callJson(app, `/spaces/${spaceId}/folders`, who)).status).toBe(404)
      expect((await callJson(app, `/spaces/${spaceId}`, { ...who, method: "PATCH", body: { name: "x" } })).status).toBe(404)
      expect((await callJson(app, `/spaces/${spaceId}`, { ...who, method: "DELETE" })).status).toBe(404)
      expect(
        (await callJson(app, `/spaces/${spaceId}/members`, { ...who, method: "POST", body: { username: "bea" } })).status,
      ).toBe(404)
      expect(
        (await callJson(app, `/spaces/${spaceId}/members/${memberRow.id}`, { ...who, method: "PATCH", body: { role: "viewer" } }))
          .status,
      ).toBe(404)
      expect((await callJson(app, `/spaces/${spaceId}/members/${memberRow.id}`, { ...who, method: "DELETE" })).status).toBe(404)
      expect((await callJson(app, `/spaces/${spaceId}/folders`, { ...who, method: "POST", body: { name: "x" } })).status).toBe(404)
      expect((await callJson(app, `/folders/${folder.body.id}`, who)).status).toBe(404)
      expect((await callJson(app, "/spaces", who)).body.spaces).toEqual([])
    }
    // still intact
    expect((await callJson(app, `/spaces/${spaceId}`, { host: t.acme.host, token: t.acme.admin.token })).body.name).toBe("Acme Space")
  })

  test("a stray cross-team membership row grants nothing", async () => {
    const t = await threeTeams(app)
    const spaceId = await acmeSpace(t)
    const folder = await callJson(app, `/spaces/${spaceId}/folders`, {
      method: "POST",
      host: t.acme.host,
      token: t.acme.admin.token,
      body: { name: "Shared" },
    })
    const up = await callMultipart(app, "/files", {
      token: t.acme.admin.token,
      host: t.acme.host,
      fields: { folder_id: String(folder.body.id) },
      files: [{ name: "plan.txt", type: "text/plain", body: "giraffe plan" }],
    })
    expect(up.status).toBe(201)
    const fileId = up.body[0].id as number

    // the kind of row the team-scoped add can no longer produce
    await db.execute(
      from("space_members").insert({ space_id: spaceId, user_id: t.beta.member.id, role: "admin", added_by: t.acme.admin.id }),
    )
    const bea = { host: t.beta.host, token: t.beta.member.token }
    expect((await callJson(app, "/spaces", bea)).body.spaces).toEqual([])
    expect((await callJson(app, `/spaces/${spaceId}`, bea)).status).toBe(404)
    expect((await callJson(app, `/spaces/${spaceId}/members`, bea)).status).toBe(404)
    expect((await callJson(app, `/spaces/${spaceId}/folders`, bea)).status).toBe(404)
    expect((await callJson(app, `/folders/${folder.body.id}`, bea)).status).toBe(404)
    expect((await callJson(app, `/files/${fileId}`, bea)).status).toBe(404)
    expect((await callJson(app, `/files/${fileId}/download`, bea)).status).toBe(404)
    expect((await callJson(app, "/search?q=plan", bea)).body).toEqual({ files: [], folders: [] })
    expect((await callJson(app, "/files?q=plan", bea)).body).toEqual([])
    expect((await callJson(app, `/shares`, { ...bea, method: "POST", body: { file_id: fileId, expires_in: 60 } })).status).toBe(404)

    // acme's own member list does not show the intruder either
    const members = await callJson(app, `/spaces/${spaceId}/members`, { host: t.acme.host, token: t.acme.admin.token })
    expect(members.body.members.map((m: any) => m.user.username)).toEqual(["admin"])
  })
})

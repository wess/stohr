import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson, callRaw } from "./helpers/http.ts"
import { callMultipart } from "./helpers/multipart.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const signup = async (name: string, username: string, email: string, invite?: string) => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name, username, email, password: "password123", invite_token: invite },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string }
}

const inviteToken = async (owner: { token: string }) => {
  const r = await callJson(app, "/invites", { method: "POST", body: {}, token: owner.token })
  expect(r.status).toBe(201)
  return r.body.token as string
}

describe("spaces", () => {
  test("creator becomes admin and can add members", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))

    const created = await callJson(app, "/spaces", {
      method: "POST", token: alice.token,
      body: { name: "Team A", description: "shared space" },
    })
    expect(created.status).toBe(201)
    expect(created.body.my_role).toBe("admin")
    expect(created.body.slug).toBeTruthy()

    const spaceId = created.body.id

    const addBob = await callJson(app, `/spaces/${spaceId}/members`, {
      method: "POST", token: alice.token,
      body: { username: "bob", role: "editor" },
    })
    expect(addBob.status).toBe(201)

    const list = await callJson(app, "/spaces", { token: bob.token })
    expect(list.body.spaces.find((s: any) => s.id === spaceId)).toBeDefined()
    expect(list.body.spaces.find((s: any) => s.id === spaceId).my_role).toBe("editor")
  })

  test("non-member sees 404 for a space", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const carol = await signup("Carol", "carol", "carol@x.test", await inviteToken(alice))
    const created = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Private" } })
    const res = await callJson(app, `/spaces/${created.body.id}`, { token: carol.token })
    expect(res.status).toBe(404)
  })

  test("editor can create a folder, viewer cannot", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const carol = await signup("Carol", "carol", "carol@x.test", await inviteToken(alice))
    const space = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Team" } })

    await callJson(app, `/spaces/${space.body.id}/members`, { method: "POST", token: alice.token, body: { username: "bob", role: "editor" } })
    await callJson(app, `/spaces/${space.body.id}/members`, { method: "POST", token: alice.token, body: { username: "carol", role: "viewer" } })

    const bobCreate = await callJson(app, `/spaces/${space.body.id}/folders`, {
      method: "POST", token: bob.token, body: { name: "Reports" },
    })
    expect(bobCreate.status).toBe(201)

    const carolCreate = await callJson(app, `/spaces/${space.body.id}/folders`, {
      method: "POST", token: carol.token, body: { name: "Nope" },
    })
    expect(carolCreate.status).toBe(403)
  })

  test("a subfolder created under a space folder is in the space, not the creator's tree", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const space = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Team" } })
    const root = await callJson(app, `/spaces/${space.body.id}/folders`, {
      method: "POST", token: alice.token, body: { name: "Reports" },
    })
    const child = await callJson(app, "/folders", {
      method: "POST", token: alice.token, body: { name: "2026", parent_id: root.body.id },
    })
    expect(child.status).toBe(201)
    expect(child.body.space_id).toBe(space.body.id)

    // Neither space folder shows up as one of Alice's personal root folders.
    const mine = await callJson(app, "/folders", { token: alice.token })
    expect(mine.body.map((f: any) => f.id)).not.toContain(root.body.id)
    expect(mine.body.map((f: any) => f.id)).not.toContain(child.body.id)
  })

  test("folders and files never move between a space and a personal tree", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const space = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Team" } })
    const root = await callJson(app, `/spaces/${space.body.id}/folders`, {
      method: "POST", token: alice.token, body: { name: "Reports" },
    })
    const personal = await callJson(app, "/folders", { method: "POST", token: alice.token, body: { name: "Mine" } })

    const out = await callJson(app, `/folders/${root.body.id}`, {
      method: "PATCH", token: alice.token, body: { parent_id: personal.body.id },
    })
    expect(out.status).toBe(422)
    const into = await callJson(app, `/folders/${personal.body.id}`, {
      method: "PATCH", token: alice.token, body: { parent_id: root.body.id },
    })
    expect(into.status).toBe(422)

    const up = await callMultipart(app, "/files", {
      token: alice.token, fields: { folder_id: String(root.body.id) },
      files: [{ name: "q1.txt", type: "text/plain", body: "numbers" }],
    })
    expect(up.status).toBe(201)
    const fileId = up.body[0].id
    const moveOut = await callJson(app, `/files/${fileId}`, {
      method: "PATCH", token: alice.token, body: { folder_id: personal.body.id },
    })
    expect(moveOut.status).toBe(422)
    const toRoot = await callJson(app, `/files/${fileId}`, {
      method: "PATCH", token: alice.token, body: { folder_id: null },
    })
    expect(toRoot.status).toBe(422)
  })

  test("a removed member keeps nothing, even for folders and files they created", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const space = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Team" } })
    await callJson(app, `/spaces/${space.body.id}/members`, {
      method: "POST", token: alice.token, body: { username: "bob", role: "editor" },
    })

    // Bob creates the folder and uploads into it: both rows carry his user_id.
    const root = await callJson(app, `/spaces/${space.body.id}/folders`, {
      method: "POST", token: bob.token, body: { name: "Bobs" },
    })
    const up = await callMultipart(app, "/files", {
      token: bob.token, fields: { folder_id: String(root.body.id) },
      files: [{ name: "plan.txt", type: "text/plain", body: "the plan" }],
    })
    expect(up.status).toBe(201)
    const fileId = up.body[0].id as number
    await db.execute(
      from("files").where(q => q("id").equals(fileId)).update({
        text_content: "the plan", text_indexed_version: 1, text_indexed_at: new Date().toISOString(),
      }),
    )

    // While a member every surface works.
    expect((await callJson(app, `/files/${fileId}`, { token: bob.token })).status).toBe(200)
    expect((await callJson(app, "/search?q=plan", { token: bob.token })).body.files).toHaveLength(1)
    expect((await callJson(app, "/search/content?q=plan", { token: bob.token })).body.files).toHaveLength(1)
    expect((await callJson(app, "/files?q=plan", { token: bob.token })).body).toHaveLength(1)

    const members = await callJson(app, `/spaces/${space.body.id}/members`, { token: alice.token })
    const bobMember = members.body.members.find((m: any) => m.user.id === bob.id)
    const removed = await callJson(app, `/spaces/${space.body.id}/members/${bobMember.id}`, {
      method: "DELETE", token: alice.token,
    })
    expect(removed.status).toBe(200)

    expect((await callJson(app, `/files/${fileId}`, { token: bob.token })).status).toBe(404)
    expect((await callJson(app, `/folders/${root.body.id}`, { token: bob.token })).status).toBe(404)
    const share = await callJson(app, "/shares", {
      method: "POST", token: bob.token, body: { file_id: fileId, expires_in: 3600 },
    })
    expect(share.status).toBe(404)
    expect((await callJson(app, "/search?q=plan", { token: bob.token })).body.files).toHaveLength(0)
    expect((await callJson(app, "/search?q=Bobs", { token: bob.token })).body.folders).toHaveLength(0)
    expect((await callJson(app, "/search/content?q=plan", { token: bob.token })).body.files).toHaveLength(0)
    expect((await callJson(app, "/files?q=plan", { token: bob.token })).body).toHaveLength(0)
    expect((await callJson(app, "/folders", { token: bob.token })).body).toHaveLength(0)

    // Trash: Alice (admin) deletes the file; it is not Bob's to see, restore or purge.
    expect((await callJson(app, `/files/${fileId}`, { method: "DELETE", token: alice.token })).status).toBe(200)
    const trash = await callJson(app, "/trash", { token: bob.token })
    expect(trash.body.files).toHaveLength(0)
    expect((await callJson(app, `/files/${fileId}/restore`, { method: "POST", token: bob.token })).status).toBe(404)
    expect((await callJson(app, `/files/${fileId}/purge`, { method: "DELETE", token: bob.token })).status).toBe(404)
    // The admin can restore it.
    expect((await callJson(app, `/files/${fileId}/restore`, { method: "POST", token: alice.token })).status).toBe(200)

    // WebDAV mounts Bob's personal tree only.
    await callJson(app, "/admin/settings", { method: "PATCH", body: { webdav_enabled: true }, token: alice.token })
    const pat = await callJson(app, "/me/apps", { method: "POST", body: { name: "dav" }, token: bob.token })
    const propfind = await callRaw(app, "/webdav/", {
      method: "PROPFIND", basic: { user: "bob@x.test", pass: pat.body.token }, headers: { depth: "1" },
    })
    expect(propfind.status).toBe(207)
    expect(propfind.text).not.toContain("Bobs")
    const get = await callRaw(app, "/webdav/Bobs/plan.txt", {
      method: "GET", basic: { user: "bob@x.test", pass: pat.body.token },
    })
    expect(get.status).toBe(404)
  })

  test("a space admin who did not upload a file can still share it; a viewer cannot", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const carol = await signup("Carol", "carol", "carol@x.test", await inviteToken(alice))
    const space = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Team" } })
    await callJson(app, `/spaces/${space.body.id}/members`, { method: "POST", token: alice.token, body: { username: "bob", role: "editor" } })
    await callJson(app, `/spaces/${space.body.id}/members`, { method: "POST", token: alice.token, body: { username: "carol", role: "viewer" } })
    const root = await callJson(app, `/spaces/${space.body.id}/folders`, { method: "POST", token: bob.token, body: { name: "Docs" } })
    const up = await callMultipart(app, "/files", {
      token: bob.token, fields: { folder_id: String(root.body.id) },
      files: [{ name: "memo.txt", type: "text/plain", body: "memo" }],
    })
    const fileId = up.body[0].id
    const byAdmin = await callJson(app, "/shares", { method: "POST", token: alice.token, body: { file_id: fileId, expires_in: 3600 } })
    expect(byAdmin.status).toBe(201)
    const byViewer = await callJson(app, "/shares", { method: "POST", token: carol.token, body: { file_id: fileId, expires_in: 3600 } })
    expect(byViewer.status).toBe(404)
  })

  test("deleting a space takes every descendant folder and file with it", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const space = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Team" } })
    await callJson(app, `/spaces/${space.body.id}/members`, { method: "POST", token: alice.token, body: { username: "bob", role: "editor" } })
    const root = await callJson(app, `/spaces/${space.body.id}/folders`, { method: "POST", token: alice.token, body: { name: "Root" } })
    const child = await callJson(app, "/folders", { method: "POST", token: alice.token, body: { name: "Child", parent_id: root.body.id } })
    const up = await callMultipart(app, "/files", {
      token: bob.token, fields: { folder_id: String(child.body.id) },
      files: [{ name: "deep.txt", type: "text/plain", body: "deep" }],
    })
    const fileId = up.body[0].id

    expect((await callJson(app, `/spaces/${space.body.id}`, { method: "DELETE", token: alice.token })).status).toBe(200)

    const rows = await db.all(from("folders").where(q => q("id").inList([root.body.id, child.body.id])).select("deleted_at")) as Array<{ deleted_at: string | null }>
    expect(rows.every(r => r.deleted_at !== null)).toBe(true)
    const file = await db.one(from("files").where(q => q("id").equals(fileId)).select("deleted_at")) as { deleted_at: string | null }
    expect(file.deleted_at).not.toBeNull()
    expect((await callJson(app, `/files/${fileId}`, { token: bob.token })).status).toBe(404)
    expect((await callJson(app, `/folders/${child.body.id}`, { token: alice.token })).status).toBe(404)
  })

  test("space owner cannot be removed and cannot be demoted from admin", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const space = await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Solo" } })
    const members = await callJson(app, `/spaces/${space.body.id}/members`, { token: alice.token })
    const me = members.body.members.find((m: any) => m.user.id === alice.id)
    expect(me).toBeDefined()
    const demote = await callJson(app, `/spaces/${space.body.id}/members/${me.id}`, {
      method: "PATCH", token: alice.token, body: { role: "editor" },
    })
    expect(demote.status).toBe(422)
    const remove = await callJson(app, `/spaces/${space.body.id}/members/${me.id}`, {
      method: "DELETE", token: alice.token,
    })
    expect(remove.status).toBe(422)
  })
})

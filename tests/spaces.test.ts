import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

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

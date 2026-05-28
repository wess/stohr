import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const signup = async (name: string, username: string, email: string, invite?: string) => {
  const res = await callJson(app, "/signup", {
    method: "POST", body: { name, username, email, password: "password123", invite_token: invite },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string }
}

const inviteToken = async (owner: { token: string }) => {
  const r = await callJson(app, "/invites", { method: "POST", body: {}, token: owner.token })
  return r.body.token as string
}

describe("comments and notifications", () => {
  test("collaborator can comment, viewer can comment, non-member cannot see", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const carol = await signup("Carol", "carol", "carol@x.test", await inviteToken(alice))

    const folder = await callJson(app, "/folders", { method: "POST", token: alice.token, body: { name: "Shared" } })
    expect(folder.status).toBe(201)
    const folderId = folder.body.id

    await callJson(app, `/folders/${folderId}/collaborators`, {
      method: "POST", token: alice.token, body: { identity: "bob", role: "viewer" },
    })

    const post = await callJson(app, `/folders/${folderId}/comments`, {
      method: "POST", token: bob.token, body: { body: "Looks great!" },
    })
    expect(post.status).toBe(201)

    const carolList = await callJson(app, `/folders/${folderId}/comments`, { token: carol.token })
    expect(carolList.status).toBe(404)

    const aliceList = await callJson(app, `/folders/${folderId}/comments`, { token: alice.token })
    expect(aliceList.body.comments).toHaveLength(1)
    expect(aliceList.body.comments[0].body).toBe("Looks great!")

    // Alice (folder owner) should have received a notification.
    const notif = await callJson(app, "/me/notifications", { token: alice.token })
    expect(notif.status).toBe(200)
    const commentNotif = notif.body.notifications.find((n: any) => n.kind === "comment.created" && n.resource_id === folderId)
    expect(commentNotif).toBeDefined()
  })

  test("author can delete own comment; folder owner can moderate", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const folder = await callJson(app, "/folders", { method: "POST", token: alice.token, body: { name: "F" } })
    await callJson(app, `/folders/${folder.body.id}/collaborators`, {
      method: "POST", token: alice.token, body: { identity: "bob", role: "editor" },
    })

    const c1 = await callJson(app, `/folders/${folder.body.id}/comments`, {
      method: "POST", token: bob.token, body: { body: "hello" },
    })
    expect(c1.status).toBe(201)

    // Alice (owner) deletes Bob's comment.
    const del = await callJson(app, `/comments/${c1.body.id}`, { method: "DELETE", token: alice.token })
    expect(del.status).toBe(200)

    const list = await callJson(app, `/folders/${folder.body.id}/comments`, { token: bob.token })
    expect(list.body.comments[0].deleted_at).not.toBeNull()
    expect(list.body.comments[0].body).toBe("")
  })

  test("mark-all-read clears unread count", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const folder = await callJson(app, "/folders", { method: "POST", token: alice.token, body: { name: "F" } })
    await callJson(app, `/folders/${folder.body.id}/collaborators`, {
      method: "POST", token: alice.token, body: { identity: "bob", role: "viewer" },
    })
    await callJson(app, `/folders/${folder.body.id}/comments`, {
      method: "POST", token: bob.token, body: { body: "ping" },
    })

    const before = await callJson(app, "/me/notifications/unread-count", { token: alice.token })
    expect(before.body.unread).toBeGreaterThan(0)
    const all = await callJson(app, "/me/notifications/read-all", { method: "POST", token: alice.token })
    expect(all.status).toBe(200)
    const after = await callJson(app, "/me/notifications/unread-count", { token: alice.token })
    expect(after.body.unread).toBe(0)
  })
})

import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { sendSystem } from "../src/messages/system.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const signup = async (name: string, username: string, email: string, password: string, invite?: string) => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name, username, email, password, invite_token: invite },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string; is_owner: boolean }
}

const ownerAndPeer = async () => {
  const alice = await signup("Alice", "alice", "alice@x.test", "password123")
  const inv = await callJson(app, "/invites", { method: "POST", body: {}, token: alice.token })
  expect(inv.status).toBe(201)
  const bob = await signup("Bob", "bob", "bob@x.test", "password123", inv.body.token)
  return { alice, bob }
}

describe("messages", () => {
  test("user-to-user send + thread fetch + reply", async () => {
    const { alice, bob } = await ownerAndPeer()

    const sent = await callJson(app, "/me/messages", {
      method: "POST",
      token: alice.token,
      body: { username: "bob", subject: "Hi Bob", body: "Welcome aboard!" },
    })
    expect(sent.status).toBe(201)
    expect(sent.body.id).toBeDefined()
    expect(sent.body.thread_id).toBe(sent.body.id)

    const inbox = await callJson(app, "/me/messages", { token: bob.token })
    expect(inbox.status).toBe(200)
    expect(inbox.body.messages.length).toBeGreaterThan(0)
    const incoming = inbox.body.messages.find((m: any) => m.subject === "Hi Bob")
    expect(incoming).toBeDefined()
    expect(incoming.from.username).toBe("alice")
    expect(incoming.read_at).toBeNull()

    const before = await callJson(app, "/me/messages/unread-count", { token: bob.token })
    const unreadBefore = before.body.unread

    const thread = await callJson(app, `/me/messages/thread/${sent.body.thread_id}`, { token: bob.token })
    expect(thread.status).toBe(200)
    expect(thread.body.messages).toHaveLength(1)

    // Fetching the thread auto-marks every message in *this* thread that
    // was addressed to Bob — should drop unread by exactly 1.
    const after = await callJson(app, "/me/messages/unread-count", { token: bob.token })
    expect(after.body.unread).toBe(unreadBefore - 1)

    const reply = await callJson(app, `/me/messages/${incoming.id}/reply`, {
      method: "POST",
      token: bob.token,
      body: { body: "Thanks!" },
    })
    expect(reply.status).toBe(201)
    expect(reply.body.thread_id).toBe(sent.body.thread_id)

    const aliceThread = await callJson(app, `/me/messages/thread/${sent.body.thread_id}`, { token: alice.token })
    expect(aliceThread.status).toBe(200)
    expect(aliceThread.body.messages).toHaveLength(2)
    expect(aliceThread.body.messages[1].body).toBe("Thanks!")
  })

  test("welcome system message lands in inbox after signup", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test", "password123")
    const inbox = await callJson(app, "/me/messages", { token: alice.token })
    expect(inbox.status).toBe(200)
    const welcome = inbox.body.messages.find((m: any) => m.kind === "system")
    expect(welcome).toBeDefined()
    expect(welcome.from).toBeNull()
  })

  test("cannot reply to a system message", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test", "password123")
    const inbox = await callJson(app, "/me/messages", { token: alice.token })
    const welcome = inbox.body.messages.find((m: any) => m.kind === "system")
    const res = await callJson(app, `/me/messages/${welcome.id}/reply`, {
      method: "POST",
      token: alice.token,
      body: { body: "hi" },
    })
    expect(res.status).toBe(422)
  })

  test("archive and unarchive", async () => {
    const { alice, bob } = await ownerAndPeer()
    await callJson(app, "/me/messages", {
      method: "POST", token: alice.token,
      body: { username: "bob", subject: "S", body: "B" },
    })
    const inbox = await callJson(app, "/me/messages", { token: bob.token })
    const m = inbox.body.messages[0]

    const archive = await callJson(app, `/me/messages/${m.id}/archive`, { method: "POST", token: bob.token })
    expect(archive.status).toBe(200)

    const inboxAfter = await callJson(app, "/me/messages", { token: bob.token })
    expect(inboxAfter.body.messages.find((x: any) => x.id === m.id)).toBeUndefined()

    const archived = await callJson(app, "/me/messages?box=archived", { token: bob.token })
    expect(archived.body.messages.find((x: any) => x.id === m.id)).toBeDefined()
  })

  test("non-participant cannot read thread", async () => {
    const { alice, bob } = await ownerAndPeer()
    const inv = await callJson(app, "/invites", { method: "POST", body: {}, token: alice.token })
    const carol = await signup("Carol", "carol", "carol@x.test", "password123", inv.body.token)

    const sent = await callJson(app, "/me/messages", {
      method: "POST", token: alice.token,
      body: { username: "bob", subject: "Private", body: "secret" },
    })
    const res = await callJson(app, `/me/messages/thread/${sent.body.thread_id}`, { token: carol.token })
    expect(res.status).toBe(404)
  })

  test("system send helper writes a system message", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test", "password123")
    const id = await sendSystem(db, alice.id, "Reminder", "Heads up.")
    expect(id).toBeGreaterThan(0)
    const inbox = await callJson(app, "/me/messages", { token: alice.token })
    const reminder = inbox.body.messages.find((m: any) => m.subject === "Reminder")
    expect(reminder).toBeDefined()
    expect(reminder.kind).toBe("system")
  })
})

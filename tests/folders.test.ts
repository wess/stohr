import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
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
  return r.body.token as string
}

// Grant directly; the collabs invitation flow is not what is under test.
const grantEditor = (folderId: number, userId: number) =>
  db.execute(
    from("collaborations").insert({
      resource_type: "folder", resource_id: folderId, user_id: userId, role: "editor",
      accepted_at: new Date().toISOString(),
    }),
  )

describe("folders", () => {
  test("an editor cannot create a public or typed folder inside a shared folder", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const shared = await callJson(app, "/folders", { method: "POST", token: alice.token, body: { name: "Shared" } })
    await grantEditor(shared.body.id, bob.id)

    const created = await callJson(app, "/folders", {
      method: "POST", token: bob.token,
      body: { name: "Leak", parent_id: shared.body.id, is_public: true, kind: "photos" },
    })
    expect(created.status).toBe(201)
    expect(created.body.is_public).toBe(false)
    expect(created.body.kind).toBe("standard")
    const row = await db.one(from("folders").where(q => q("id").equals(created.body.id)).select("is_public", "kind")) as any
    expect(row.is_public).toBe(false)
    expect(row.kind).toBe("standard")

    // The owner's own request is honored as before.
    const own = await callJson(app, "/folders", {
      method: "POST", token: alice.token,
      body: { name: "Public", parent_id: shared.body.id, is_public: true, kind: "photos" },
    })
    expect(own.body.is_public).toBe(true)
    expect(own.body.kind).toBe("photos")
  })
})

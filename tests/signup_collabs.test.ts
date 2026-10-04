import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { sha256Hex } from "../src/util/token.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

// Owner, a folder, and a collaborator grant waiting on bob@example.com.
const seedPending = async () => {
  const owner = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  const folder = await callJson(app, "/folders", { method: "POST", token: owner.body.token, body: { name: "Docs" } })
  await db.execute(
    from("collaborations").insert({
      resource_type: "folder",
      resource_id: folder.body.id,
      user_id: null,
      email: "bob@example.com",
      role: "editor",
      invited_by: owner.body.id,
    }),
  )
  return { folderId: folder.body.id as number }
}

const pendingRow = async (folderId: number) =>
  (await db.one(
    from("collaborations")
      .where(q => q("resource_id").equals(folderId))
      .select("user_id", "email"),
  )) as { user_id: number | null; email: string | null }

describe("pending collaborator grants at signup", () => {
  test("a typed-in email does not claim the grant", async () => {
    const { folderId } = await seedPending()
    const inviteToken = `inv-${Math.random().toString(36).slice(2)}`
    await db.execute(from("invites").insert({ token_hash: sha256Hex(inviteToken) }))

    const bob = await callJson(app, "/signup", {
      method: "POST",
      body: {
        name: "Mallory",
        username: "mallory",
        email: "bob@example.com",
        password: "password123",
        invite_token: inviteToken,
      },
    })
    expect(bob.status).toBe(201)

    const row = await pendingRow(folderId)
    expect(row.user_id).toBeNull()
    expect(row.email).toBe("bob@example.com")
  })

  test("an invite mailed to that address does", async () => {
    const { folderId } = await seedPending()
    const inviteToken = `inv-${Math.random().toString(36).slice(2)}`
    await db.execute(from("invites").insert({ token_hash: sha256Hex(inviteToken), email: "bob@example.com" }))

    const bob = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Bob", username: "bob", email: "bob@example.com", password: "password123", invite_token: inviteToken },
    })
    expect(bob.status).toBe(201)

    const row = await pendingRow(folderId)
    expect(row.user_id).toBe(bob.body.id)
    expect(row.email).toBeNull()
  })
})

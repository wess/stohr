import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { uniqueUsername, upsertFromExternal } from "../src/auth/external.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const signupOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string }
}

const identities = async () =>
  (await db.all(from("external_identities").select("user_id", "provider", "subject"))) as Array<{
    user_id: number
    provider: string
    subject: string
  }>

describe("external identity linking", () => {
  test("a verified email links to the existing local account", async () => {
    const owner = await signupOwner()
    const r = await upsertFromExternal(
      db,
      { provider: "oidc", subject: "sub-1", email: "Owner@Example.com", email_verified: true, display_name: "O" },
      { autoProvision: false },
    )
    expect(r.created).toBe(false)
    expect(r.user.id).toBe(owner.id)
    expect(await identities()).toEqual([{ user_id: owner.id, provider: "oidc", subject: "sub-1" }])
  })

  test("an unverified email never links, even when it matches", async () => {
    await signupOwner()
    await expect(
      upsertFromExternal(
        db,
        { provider: "oidc", subject: "sub-2", email: "owner@example.com", email_verified: false, display_name: null },
        { autoProvision: false },
      ),
    ).rejects.toThrow(/auto-provision is disabled/)
    expect(await identities()).toEqual([])
  })

  test("an unverified email cannot seed a new account either", async () => {
    await signupOwner()
    await expect(
      upsertFromExternal(
        db,
        { provider: "google", subject: "g-1", email: "someone@example.com", email_verified: false, display_name: null },
        { autoProvision: true },
      ),
    ).rejects.toThrow(/verified/)
    const users = await db.all(from("users").select("id"))
    expect(users).toHaveLength(1)
  })

  test("a verified email provisions and resolves pending collaborator invites", async () => {
    const owner = await signupOwner()
    const folder = await callJson(app, "/folders", { method: "POST", token: owner.token, body: { name: "Docs" } })
    expect(folder.status).toBe(201)
    await db.execute(
      from("collaborations").insert({
        resource_type: "folder",
        resource_id: folder.body.id,
        user_id: null,
        email: "new@example.com",
        role: "viewer",
        invited_by: owner.id,
      }),
    )

    const r = await upsertFromExternal(
      db,
      { provider: "oidc", subject: "sub-3", email: "new@example.com", email_verified: true, display_name: "New" },
      { autoProvision: true },
    )
    expect(r.created).toBe(true)
    const collab = (await db.one(
      from("collaborations")
        .where(q => q("resource_id").equals(folder.body.id))
        .select("user_id", "email"),
    )) as { user_id: number | null; email: string | null }
    expect(collab.user_id).toBe(r.user.id)
    expect(collab.email).toBeNull()
  })

  test("the (provider, subject) link wins over email on later logins", async () => {
    const owner = await signupOwner()
    await upsertFromExternal(
      db,
      { provider: "oidc", subject: "sub-1", email: "owner@example.com", email_verified: true, display_name: null },
      { autoProvision: false },
    )
    // IdP-side email changed and is no longer verified — still the same user
    const again = await upsertFromExternal(
      db,
      { provider: "oidc", subject: "sub-1", email: "other@example.com", email_verified: false, display_name: null },
      { autoProvision: false },
    )
    expect(again.user.id).toBe(owner.id)
  })
})

describe("uniqueUsername", () => {
  test("suffixes a taken handle and repairs an unusable one", async () => {
    await signupOwner()
    const alt = await uniqueUsername(db, "owner")
    expect(alt).not.toBe("owner")
    expect(alt.startsWith("owner_")).toBe(true)
    expect(alt).toMatch(/^[a-z0-9_]{3,32}$/)

    const repaired = await uniqueUsername(db, "a b")
    expect(repaired).toMatch(/^user_[a-f0-9]{8}$/)
  })
})

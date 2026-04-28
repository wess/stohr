import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from, raw } from "@atlas/db"
import { hash } from "@atlas/auth"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

// Helper: create a user (Alice = first user / owner) and seed a file row that
// shares can reference. We bypass the upload route entirely since these tests
// are about the share lifecycle, not storage I/O.
const setup = async (): Promise<{ token: string; userId: number; fileId: number }> => {
  const signup = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@example.com", password: "password123" },
  })
  const userId = signup.body.id as number
  const inserted = await db.execute(
    from("files").insert({
      user_id: userId,
      folder_id: null,
      name: "secret.txt",
      mime: "text/plain",
      size: 100,
      storage_key: `u${userId}/test/secret.txt`,
    }).returning("id"),
  ) as Array<{ id: number }>
  return { token: signup.body.token, userId, fileId: inserted[0]!.id }
}

describe("share creation", () => {
  test("expires_in is required", async () => {
    const { token, fileId } = await setup()
    const res = await callJson(app, "/shares", {
      method: "POST",
      body: { file_id: fileId },
      token,
    })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/expires_in/)
  })

  test("expires_in capped at 30 days", async () => {
    const { token, fileId } = await setup()
    const tooLong = await callJson(app, "/shares", {
      method: "POST",
      body: { file_id: fileId, expires_in: 60 * 86400 },
      token,
    })
    expect(tooLong.status).toBe(422)
  })

  test("returns password_required + burn_on_view flags", async () => {
    const { token, fileId } = await setup()
    const res = await callJson(app, "/shares", {
      method: "POST",
      body: { file_id: fileId, expires_in: 3600, password: "letmein", burn_on_view: true },
      token,
    })
    expect(res.status).toBe(201)
    expect(res.body.password_required).toBe(true)
    expect(res.body.burn_on_view).toBe(true)
    expect(res.body.token).toBeTruthy()

    // Stored hashed, not plaintext.
    const row = await db.one(
      from("shares").where(q => q("token").equals(res.body.token)).select("password_hash"),
    ) as { password_hash: string } | null
    expect(row?.password_hash).toBeTruthy()
    expect(row?.password_hash).not.toBe("letmein")
  })
})

describe("share viewer (meta + lifecycle)", () => {
  test("?meta=1 surfaces password_required without consuming burn", async () => {
    const { token, fileId } = await setup()
    const create = await callJson(app, "/shares", {
      method: "POST",
      body: { file_id: fileId, expires_in: 3600, password: "letmein", burn_on_view: true },
      token,
    })
    const shareToken = create.body.token

    const meta1 = await callJson(app, `/s/${shareToken}?meta=1`)
    const meta2 = await callJson(app, `/s/${shareToken}?meta=1`)
    expect(meta1.status).toBe(200)
    expect(meta1.body.password_required).toBe(true)
    expect(meta1.body.burn_on_view).toBe(true)
    // Meta calls do NOT burn the share.
    expect(meta2.status).toBe(200)
  })

  test("expired share is deleted and 410'd on access", async () => {
    const { token, fileId } = await setup()
    const create = await callJson(app, "/shares", {
      method: "POST",
      body: { file_id: fileId, expires_in: 3600 },
      token,
    })
    // Force expiry into the past.
    await db.execute(
      from("shares").where(q => q("token").equals(create.body.token)).update({
        expires_at: raw("NOW() - INTERVAL '5 minutes'"),
      }),
    )

    const meta = await callJson(app, `/s/${create.body.token}?meta=1`)
    expect(meta.status).toBe(410)

    const row = await db.one(
      from("shares").where(q => q("token").equals(create.body.token)).select("id"),
    )
    expect(row).toBeNull()
  })

  test("password gate returns 401 with password_required: true", async () => {
    const { fileId, userId } = await setup()
    const tokenHash = await hash("letmein")
    const inserted = await db.execute(
      from("shares").insert({
        file_id: fileId,
        user_id: userId,
        token: "tok-pw-test",
        expires_at: raw("NOW() + INTERVAL '1 hour'"),
        password_hash: tokenHash,
        burn_on_view: false,
      }).returning("id"),
    ) as Array<{ id: number }>
    expect(inserted).toHaveLength(1)

    const noPw = await callJson(app, "/s/tok-pw-test")
    expect(noPw.status).toBe(401)
    expect(noPw.body.password_required).toBe(true)

    const wrongPw = await callJson(app, "/s/tok-pw-test", {
      headers: { "x-share-password": "wrong" },
    })
    expect(wrongPw.status).toBe(401)
  })

  test("burn_on_view atomic claim — only one non-owner viewer wins", async () => {
    // Insert a share row directly so we don't have to mock the file storage path.
    const { fileId, userId } = await setup()
    const inserted = await db.execute(
      from("shares").insert({
        file_id: fileId,
        user_id: userId,
        token: "tok-burn-test",
        expires_at: raw("NOW() + INTERVAL '1 hour'"),
        burn_on_view: true,
      }).returning("id"),
    ) as Array<{ id: number }>
    expect(inserted).toHaveLength(1)

    // The download path will hit the fakeStore which returns no body and 500.
    // What we care about is the share row being deleted exactly once.
    await callJson(app, "/s/tok-burn-test")
    const row1 = await db.one(
      from("shares").where(q => q("token").equals("tok-burn-test")).select("id"),
    )
    expect(row1).toBeNull()

    // Second hit gets 404 — share is already gone.
    const second = await callJson(app, "/s/tok-burn-test")
    expect(second.status).toBe(404)
  })
})

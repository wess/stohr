import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { folderRoutes } from "../src/folders/index.ts"
import { inviteRoutes } from "../src/invites/index.ts"
import { uploadRoutes } from "../src/uploads/index.ts"
import { MAX_SESSIONS_PER_USER, MAX_UPLOAD_BYTES } from "../src/uploads/config.ts"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { callJson, callRaw, fakeStore } from "./helpers/http.ts"

// The chunk path stages parts in the StorageHandle only under the local
// driver; anything else would try to open a real S3 multipart upload.
process.env.STORAGE_DRIVER = "local"

let app: ReturnType<typeof router>

beforeAll(() => {
  app = router(
    ...authRoutes(db, TEST_SECRET),
    ...inviteRoutes(db, TEST_SECRET),
    ...folderRoutes(db, TEST_SECRET, fakeStore),
    ...uploadRoutes(db, fakeStore, TEST_SECRET),
  )
})
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

const init = (token: string, body: Record<string, unknown>) =>
  callJson(app, "/files/upload/init", { method: "POST", token, body })

const chunk = (token: string, id: string, bytes: string) =>
  callRaw(app, `/files/upload/${id}/chunk`, {
    method: "POST", body: bytes,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
  })

describe("chunked uploads", () => {
  test("the declared total is capped at MAX_UPLOAD_BYTES", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const r = await init(alice.token, { file_name: "huge.bin", total_size: MAX_UPLOAD_BYTES + 1 })
    expect(r.status).toBe(413)
  })

  test("open sessions are capped per user", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
      expect((await init(alice.token, { file_name: `f${i}.bin`, total_size: 10 })).status).toBe(201)
    }
    const over = await init(alice.token, { file_name: "one-too-many.bin", total_size: 10 })
    expect(over.status).toBe(429)
  })

  test("bytes promised to open sessions count against the quota at init", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    await db.execute(from("users").where(q => q("id").equals(alice.id)).update({ storage_quota_bytes: 1000 }))
    expect((await init(alice.token, { file_name: "a.bin", total_size: 600 })).status).toBe(201)
    const second = await init(alice.token, { file_name: "b.bin", total_size: 600 })
    expect(second.status).toBe(402)
    // Aborting the first frees the reservation.
    const sessions = await db.all(from("upload_sessions").select("id")) as Array<{ id: string }>
    await callJson(app, `/files/upload/${sessions[0]!.id}`, { method: "DELETE", token: alice.token })
    expect((await init(alice.token, { file_name: "b.bin", total_size: 600 })).status).toBe(201)
  })

  test("a collaborator's session into a shared folder is theirs to drive", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    const bob = await signup("Bob", "bob", "bob@x.test", await inviteToken(alice))
    const shared = await callJson(app, "/folders", { method: "POST", token: alice.token, body: { name: "Shared" } })
    await db.execute(
      from("collaborations").insert({
        resource_type: "folder", resource_id: shared.body.id, user_id: bob.id, role: "editor",
        accepted_at: new Date().toISOString(),
      }),
    )

    const session = await init(bob.token, { file_name: "notes.txt", total_size: 5, mime: "text/plain", folder_id: shared.body.id })
    expect(session.status).toBe(201)
    expect(session.body.owner_id).toBe(alice.id)

    // Used to 404 here: the row was keyed by the folder owner, not by Bob.
    expect((await callJson(app, `/files/upload/${session.body.id}/status`, { token: bob.token })).status).toBe(200)
    expect((await chunk(bob.token, session.body.id, "hello")).status).toBe(200)
    const done = await callJson(app, `/files/upload/${session.body.id}/finalize`, { method: "POST", token: bob.token })
    expect(done.status).toBe(201)
    expect(done.body.name).toBe("notes.txt")

    const row = await db.one(from("files").where(q => q("id").equals(done.body.id)).select("user_id", "folder_id", "scan_status")) as any
    expect(row.user_id).toBe(alice.id)
    expect(row.folder_id).toBe(shared.body.id)
    expect(row.scan_status).toBe("skipped")
  })

  test("finalize re-checks the quota and rolls the file back on overflow", async () => {
    const alice = await signup("Alice", "alice", "alice@x.test")
    await db.execute(from("users").where(q => q("id").equals(alice.id)).update({ storage_quota_bytes: 100 }))
    const session = await init(alice.token, { file_name: "late.txt", total_size: 60 })
    expect(session.status).toBe(201)
    // Something else lands while the upload is in flight.
    await db.execute(
      from("files").insert({ user_id: alice.id, folder_id: null, name: "other.bin", mime: "application/octet-stream", size: 90, storage_key: "u/other" }),
    )
    expect((await chunk(alice.token, session.body.id, "x".repeat(60))).status).toBe(200)
    const done = await callJson(app, `/files/upload/${session.body.id}/finalize`, { method: "POST", token: alice.token })
    expect(done.status).toBe(402)
    const leftover = await db.one(from("files").where(q => q("name").equals("late.txt")).select("id"))
    expect(leftover).toBeNull()
    const session2 = await db.one(from("upload_sessions").where(q => q("id").equals(session.body.id)).select("id"))
    expect(session2).toBeNull()
  })
})

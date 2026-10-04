import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { callMultipart } from "./helpers/multipart.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const signup = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@x.test", password: "password123" },
  })
  return res.body as { id: number; token: string }
}

const upload = (token: string, name: string, body: string) =>
  callMultipart(app, "/files", { token, files: [{ name, type: "text/plain", body }] })

const scanOf = async (id: number) =>
  (await db.one(from("files").where(q => q("id").equals(id)).select("scan_status", "scan_signature", "scanned_at"))) as any

const flag = (id: number) =>
  db.execute(
    from("files").where(q => q("id").equals(id)).update({
      scan_status: "infected", scan_signature: "Eicar-Test", scanned_at: new Date().toISOString(),
    }),
  )

// No clamd in tests, so a fresh verdict is 'skipped'; with CLAMD_HOST set it
// would be 'pending'. Either way the old verdict must not survive new bytes.
describe("scan verdicts follow the bytes", () => {
  test("re-uploading a name replaces the verdict along with the content", async () => {
    const alice = await signup()
    const v1 = await upload(alice.token, "doc.txt", "first")
    const id = v1.body[0].id as number
    await flag(id)
    expect((await callJson(app, `/files/${id}/download`, { token: alice.token })).status).toBe(403)

    const v2 = await upload(alice.token, "doc.txt", "second")
    expect(v2.status).toBe(201)
    expect(v2.body[0].new_version).toBe(true)
    const after = await scanOf(id)
    expect(after.scan_status).toBe("skipped")
    expect(after.scan_signature).toBeNull()
    expect(after.scanned_at).toBeNull()
    expect((await callJson(app, `/files/${id}/download`, { token: alice.token })).status).toBe(200)
  })

  test("restoring an older version does not carry the current verdict over", async () => {
    const alice = await signup()
    const v1 = await upload(alice.token, "doc.txt", "first")
    const id = v1.body[0].id as number
    await upload(alice.token, "doc.txt", "second")
    // The live row (v2) scanned clean; v1's bytes are about to become live again.
    await db.execute(from("files").where(q => q("id").equals(id)).update({ scan_status: "clean", scanned_at: new Date().toISOString() }))

    const restored = await callJson(app, `/files/${id}/versions/1/restore`, { method: "POST", token: alice.token })
    expect(restored.status).toBe(200)
    const after = await scanOf(id)
    expect(after.scan_status).toBe("skipped")
    expect(after.scanned_at).toBeNull()
  })
})

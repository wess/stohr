import { beforeAll, beforeEach, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson, callRaw, fakeStore } from "./helpers/http.ts"
import { callMultipart } from "./helpers/multipart.ts"

let app: ReturnType<typeof buildApp>
beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

test("infected versions stay quarantined after replacement and restoration", async () => {
  const owner = (await callJson(app, "/signup", { method: "POST", body: {
    name: "Owner", username: "owner", email: "owner@x.test", password: "password123",
  } })).body
  const upload = async (body: string) => await callMultipart(app, "/files", {
    token: owner.token, files: [{ name: "scan.txt", type: "text/plain", body }],
  })
  const file = (await upload("quarantined fixture")).body[0]
  const scannedAt = new Date().toISOString()
  await db.execute(from("files").where(q => q("id").equals(file.id)).update({
    scan_status: "infected", scan_signature: "test.fixture", scanned_at: scannedAt,
  }))
  expect((await callJson(app, `/files/${file.id}/versions/1/download`, { token: owner.token })).status).toBe(403)
  expect((await upload("clean replacement")).status).toBe(201)
  expect((await callJson(app, `/files/${file.id}/download`, { token: owner.token })).status).toBe(200)
  expect((await callJson(app, `/files/${file.id}/versions/1/download`, { token: owner.token })).status).toBe(403)
  const archived = await db.one(from("file_versions").where(q => q("file_id").equals(file.id)).where(q => q("version").equals(1)))
  expect(archived.scan_status).toBe("infected")
  expect(archived.scan_signature).toBe("test.fixture")
  expect((await callJson(app, `/files/${file.id}/versions/1/restore`, { method: "POST", token: owner.token })).status).toBe(200)
  const current = await db.one(from("files").where(q => q("id").equals(file.id)))
  expect(current.scan_status).toBe("infected")
  expect(current.scan_signature).toBe("test.fixture")
  expect((await callJson(app, `/files/${file.id}/download`, { token: owner.token })).status).toBe(403)
  expect((await callJson(app, `/files/${file.id}/versions/3/download`, { token: owner.token })).status).toBe(403)
})

test("configured scanning gates every file delivery until a clean verdict", async () => {
  const configured = process.env.CLAMD_HOST
  process.env.CLAMD_HOST = "scanner.test.invalid"
  try {
    const owner = (await callJson(app, "/signup", { method: "POST", body: {
      name: "Owner", username: "owner", email: "owner@x.test", password: "password123",
    } })).body
    const folder = (await callJson(app, "/folders", {
      method: "POST", token: owner.token, body: { name: "Public", is_public: true },
    })).body
    const upload = async (body: string) => await callMultipart(app, "/files", {
      token: owner.token, fields: { folder_id: String(folder.id) },
      files: [{ name: "scan.txt", type: "text/plain", body }],
    })
    const file = (await upload("old bytes")).body[0]
    await upload("new bytes")
    const thumbKey = `scanfixture/${file.id}`
    await fakeStore.put(thumbKey, "thumbnail", "image/webp")
    await db.execute(from("files").where(q => q("id").equals(file.id)).update({ thumb_key: thumbKey }))
    await db.execute(from("files").where(q => q("id").equals(file.id)).update({
      text_content: "quarantined secret", text_indexed_version: 2, text_indexed_at: new Date().toISOString(),
    }))
    const share = (await callJson(app, "/shares", {
      method: "POST", token: owner.token, body: { file_id: file.id, expires_in: 3600 },
    })).body
    await callJson(app, "/admin/settings", { method: "PATCH", token: owner.token, body: { webdav_enabled: true } })
    const pat = (await callJson(app, "/me/apps", { method: "POST", token: owner.token, body: { name: "dav" } })).body.token
    const basic = { user: "owner@x.test", pass: pat }
    const paths = [
      `/files/${file.id}/download`, `/files/${file.id}/thumb`,
      `/files/${file.id}/versions/1/download`, `/files/${file.id}/versions/2/download`,
      `/p/files/${file.id}`, `/p/files/${file.id}/thumb`, `/s/${share.token}`,
    ]
    for (const status of ["pending", "error", "skipped", "infected", "clean"]) {
      await db.execute(from("files").where(q => q("id").equals(file.id)).update({ scan_status: status }))
      await db.execute(from("file_versions").where(q => q("file_id").equals(file.id)).update({ scan_status: status }))
      const expected = status === "clean" ? 200 : 403
      const search = await callJson(app, "/search/content?q=quarantined", { token: owner.token })
      expect(search.body.files).toHaveLength(status === "clean" ? 1 : 0)
      for (const path of paths) expect((await callJson(app, path, { token: owner.token })).status).toBe(expected)
      expect((await callRaw(app, "/webdav/Public/scan.txt", { basic })).status).toBe(expected)
      const copied = await callRaw(app, "/webdav/Public/scan.txt", {
        method: "COPY", basic, headers: { destination: "http://test.local/webdav/copy.txt" },
      })
      expect(copied.status).toBe(status === "clean" ? 201 : 403)
    }
  } finally {
    if (configured === undefined) delete process.env.CLAMD_HOST
    else process.env.CLAMD_HOST = configured
  }
})

test("a delayed verdict follows the archived blob instead of approving its replacement", async () => {
  const { scanFileRow } = await import("../src/scanning/index.ts")
  const { fakeStore } = await import("./helpers/http.ts")
  const owner = (await callJson(app, "/signup", { method: "POST", body: {
    name: "Owner", username: "owner", email: "owner@x.test", password: "password123",
  } })).body
  const file = (await callMultipart(app, "/files", {
    token: owner.token, files: [{ name: "delayed.txt", type: "text/plain", body: "old bytes" }],
  })).body[0]
  const old = await db.one(from("files").where(q => q("id").equals(file.id)))
  await callMultipart(app, "/files", {
    token: owner.token, files: [{ name: "delayed.txt", type: "text/plain", body: "new bytes" }],
  })
  await db.execute(from("files").where(q => q("id").equals(file.id)).update({ scan_status: "infected" }))
  await scanFileRow(db, fakeStore, old)
  const live = await db.one(from("files").where(q => q("id").equals(file.id)))
  const archived = await db.one(from("file_versions").where(q => q("file_id").equals(file.id)))
  expect(live.scan_status).toBe("infected")
  expect(archived.scan_status).toBe("skipped")
  expect(live.storage_key).not.toBe(archived.storage_key)
})

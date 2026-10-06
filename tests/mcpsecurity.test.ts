import { from } from "@atlas/db"
import { beforeEach, expect, test } from "bun:test"
import { buildToolset, type ToolContext } from "../src/mcp/tools/index.ts"
import { checkActionQuota, finishActionWrite } from "../src/actions/quota.ts"
import type { FileRow } from "../src/permissions/index.ts"
import { findOrCreateFolder } from "../src/actions/primitives/util/folders.ts"
import { folderAccess } from "../src/permissions/index.ts"
import { fakeStore } from "./helpers/http.ts"
import { db, truncateAll } from "./setup.ts"

beforeEach(truncateAll)

const fixture = async () => {
  const users = [] as Array<{ id: number }>
  for (const user of [
    { name: "Owner", username: "owner", email: "owner@example.com", password: "unused" },
    { name: "Member", username: "member", email: "member@example.com", password: "unused" },
  ]) users.push(...await db.execute(from("users").insert(user).returning("id")) as Array<{ id: number }>)
  const [owner, member] = users.map(u => u.id)
  const spaces = await db.execute(from("spaces").insert({ name: "Editorial", slug: "editorial", owner_id: owner }).returning("id")) as Array<{ id: number }>
  const spaceId = spaces[0]!.id
  for (const userId of [owner, member]) await db.execute(from("space_members").insert({ space_id: spaceId, user_id: userId, role: "admin" }))
  const folders = await db.execute(from("folders").insert({ name: "Secret", user_id: member, space_id: spaceId }).returning("id")) as Array<{ id: number }>
  const folderId = folders[0]!.id
  await fakeStore.put("secret", "confidential")
  const files = await db.execute(from("files").insert({ name: "Secret.txt", user_id: member, folder_id: folderId, storage_key: "secret", mime: "text/plain", size: 12 }).returning("id")) as Array<{ id: number }>
  const ctx: ToolContext = { db, store: fakeStore, userId: member!, teamId: 1, appUrl: "https://test.example" }
  const call = (name: string, args: Record<string, unknown>) => buildToolset().find(t => t.name === name)!.handler(ctx, args)
  return { owner: owner!, member: member!, spaceId, folderId, fileId: files[0]!.id, ctx, call }
}

const payload = (result: Awaited<ReturnType<ReturnType<typeof buildToolset>[number]["handler"]>>) => JSON.parse((result.content[0] as { text: string }).text)

test("removed Space member cannot search, share, or restore attributed content", async () => {
  const f = await fixture()
  await db.execute(from("space_members").where(q => q("space_id").equals(f.spaceId)).where(q => q("user_id").equals(f.member)).del())
  const found = payload(await f.call("search", { query: "Secret" }))
  expect(found.files).toEqual([])
  expect(found.folders).toEqual([])
  expect(payload(await f.call("list_folders", {}))).toEqual([])
  expect((await f.call("create_share", { file_id: f.fileId, expires_in: 60 })).isError).toBe(true)
  await db.execute(from("files").where(q => q("id").equals(f.fileId)).update({ deleted_at: new Date() }))
  await db.execute(from("folders").where(q => q("id").equals(f.folderId)).update({ deleted_at: new Date() }))
  expect((await f.call("restore_file", { id: f.fileId })).isError).toBe(true)
  expect((await f.call("restore_folder", { id: f.folderId })).isError).toBe(true)
})

test("MCP and action-created Space descendants retain membership boundary", async () => {
  const f = await fixture()
  const child = payload(await f.call("create_folder", { name: "Child", parent_id: f.folderId }))
  const actionChild = await findOrCreateFolder(db, f.member, f.folderId, "Organized")
  for (const id of [child.id, actionChild]) {
    const row = await db.one(from("folders").where(q => q("id").equals(id))) as { space_id: number }
    expect(row.space_id).toBe(f.spaceId)
  }
  await db.execute(from("space_members").where(q => q("user_id").equals(f.member)).del())
  expect(await folderAccess(db, f.member, child.id)).toBeNull()
  expect(await folderAccess(db, f.member, actionChild)).toBeNull()
})

test("MCP moves reject crossing Space boundary and descendant cycles", async () => {
  const f = await fixture()
  expect((await f.call("move_file", { id: f.fileId, folder_id: null })).isError).toBe(true)
  expect((await f.call("move_folder", { id: f.folderId, parent_id: null })).isError).toBe(true)
  const child = payload(await f.call("create_folder", { name: "Child", parent_id: f.folderId }))
  expect((await f.call("move_folder", { id: f.folderId, parent_id: child.id })).isError).toBe(true)
})

test("MCP rejects infected file bytes and invalid read bounds", async () => {
  const f = await fixture()
  expect((await f.call("read_file", { id: f.fileId, max_bytes: "invalid" })).isError).toBe(true)
  await db.execute(from("files").where(q => q("id").equals(f.fileId)).update({ scan_status: "infected" }))
  expect((await f.call("read_file", { id: f.fileId })).isError).toBe(true)
})

test("MCP overwrite preserves the archived malware verdict", async () => {
  const f = await fixture()
  await db.execute(from("files").where(q => q("id").equals(f.fileId)).update({ scan_status: "infected", scan_signature: "test-virus", scanned_at: new Date() }))
  const written = await f.call("write_file", { name: "Secret.txt", folder_id: f.folderId, content: "replacement", mime: "text/plain" })
  expect(written.isError).not.toBe(true)
  const version = await db.one(from("file_versions").where(q => q("file_id").equals(f.fileId))) as { scan_status: string; scan_signature: string }
  expect(version.scan_status).toBe("infected")
  expect(version.scan_signature).toBe("test-virus")
  const current = await db.one(from("files").where(q => q("id").equals(f.fileId))) as { scan_status: string; scan_signature: string | null }
  expect(current.scan_status).not.toBe("infected")
  expect(current.scan_signature).toBeNull()
})


test("action quota rollback restores its version and leaves a later writer intact", async () => {
  const f = await fixture()
  const previous = await db.one(from("files").where(q => q("id").equals(f.fileId))) as FileRow
  await db.execute(from("users").where(q => q("id").equals(f.member)).update({ storage_quota_bytes: 12 }))
  await expect(checkActionQuota(db, f.member, 1)).rejects.toThrow(/quota/)
  await fakeStore.put("action-output", "larger output")
  await db.execute(from("file_versions").insert({ file_id: f.fileId, version: previous.version, mime: previous.mime, size: previous.size, storage_key: previous.storage_key }))
  await db.execute(from("files").where(q => q("id").equals(f.fileId)).update({ storage_key: "action-output", size: 13, version: 2 }))
  await expect(finishActionWrite(db, fakeStore, f.member, 12, 13, "action-output", previous)).rejects.toThrow(/quota/)
  const restored = await db.one(from("files").where(q => q("id").equals(f.fileId))) as FileRow
  expect(restored.storage_key).toBe(previous.storage_key)
  expect(restored.version).toBe(previous.version)
  expect((await fakeStore.get("action-output")).status).toBe(404)
  await db.execute(from("files").where(q => q("id").equals(f.fileId)).update({ storage_key: "later-writer", size: 30, version: 3 }))
  await expect(finishActionWrite(db, fakeStore, f.member, 12, 13, "action-output", previous)).rejects.toThrow(/quota/)
  const later = await db.one(from("files").where(q => q("id").equals(f.fileId))) as FileRow
  expect(later.storage_key).toBe("later-writer")
  expect(later.version).toBe(3)
})


test("configured malware scanning blocks unfinished MCP verdicts", async () => {
  const previous = process.env.CLAMD_HOST
  process.env.CLAMD_HOST = "127.0.0.1"
  try {
    const f = await fixture()
    for (const scanStatus of ["pending", "error", "skipped", "infected"]) {
      await db.execute(from("files").where(q => q("id").equals(f.fileId)).update({ scan_status: scanStatus }))
      expect((await f.call("read_file", { id: f.fileId })).isError).toBe(true)
    }
    await db.execute(from("files").where(q => q("id").equals(f.fileId)).update({ scan_status: "clean" }))
    expect((await f.call("read_file", { id: f.fileId })).isError).not.toBe(true)
  } finally {
    if (previous === undefined) delete process.env.CLAMD_HOST
    else process.env.CLAMD_HOST = previous
  }
})

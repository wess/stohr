import { beforeAll, beforeEach, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { callMultipart } from "./helpers/multipart.ts"
import { purgeUser } from "../src/auth/deletion.ts"
import { fakeStore } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>
beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const fixture = async () => {
  const alice = (await callJson(app, "/signup", { method: "POST", body: {
    name: "Alice", username: "alice", email: "alice@x.test", password: "password123",
  } })).body
  const invite = (await callJson(app, "/invites", { method: "POST", token: alice.token, body: {} })).body.token
  const bob = (await callJson(app, "/signup", { method: "POST", body: {
    name: "Bob", username: "bob", email: "bob@x.test", password: "password123", invite_token: invite,
  } })).body
  const space = (await callJson(app, "/spaces", { method: "POST", token: alice.token, body: { name: "Team" } })).body
  const member = (await callJson(app, `/spaces/${space.id}/members`, {
    method: "POST", token: alice.token, body: { user_id: bob.id, role: "admin" },
  })).body
  const folder = (await callJson(app, `/spaces/${space.id}/folders`, {
    method: "POST", token: bob.token, body: { name: "Secrets" },
  })).body
  const file = (await callMultipart(app, "/files", {
    token: bob.token, fields: { folder_id: String(folder.id) },
    files: [{ name: "secret.txt", type: "text/plain", body: "secret memorandum" }],
  })).body[0]
  return { alice, bob, space, member, folder, file }
}

test("restoring a file cannot detach it from a trashed Space folder", async () => {
  const { alice, bob, space, member, folder, file } = await fixture()
  expect((await callJson(app, `/folders/${folder.id}`, { method: "DELETE", token: alice.token })).status).toBe(200)
  const restored = await callJson(app, `/files/${file.id}/restore`, { method: "POST", token: bob.token })
  expect(restored.status).toBe(409)
  const row = await db.one(from("files").where(q => q("id").equals(file.id)).select("folder_id", "deleted_at"))
  expect(row.folder_id).toBe(folder.id)
  expect(row.deleted_at).not.toBeNull()
  await callJson(app, `/spaces/${space.id}/members/${member.id}`, { method: "DELETE", token: alice.token })
  expect((await callJson(app, `/files/${file.id}`, { token: bob.token })).status).toBe(404)
})

test("Space grants cannot expose content or names to a removed member", async () => {
  const { alice, bob, space, member, folder, file } = await fixture()
  for (const [kind, id] of [["file", file.id], ["folder", folder.id]] as const) {
    expect((await callJson(app, `/${kind}s/${id}/collaborators`, {
      method: "POST", token: alice.token, body: { identity: "bob", role: "viewer" },
    })).status).toBe(422)
    // legacy grants must not outlive Space membership either
    await db.execute(from("collaborations").insert({
      resource_type: kind, resource_id: id, user_id: bob.id, role: "viewer", invited_by: alice.id,
    }))
  }
  await db.execute(from("files").where(q => q("id").equals(file.id)).update({
    text_content: "secret memorandum", text_indexed_version: 1, text_indexed_at: new Date().toISOString(),
  }))
  await callJson(app, `/spaces/${space.id}/members/${member.id}`, { method: "DELETE", token: alice.token })
  expect((await callJson(app, "/search/content?q=secret", { token: bob.token })).body.files).toHaveLength(0)
  const shared = (await callJson(app, "/shared", { token: bob.token })).body
  expect(shared.files).toHaveLength(0)
  expect(shared.folders).toHaveLength(0)
})

test("member upsert cannot demote a Space owner", async () => {
  const { alice, bob, space } = await fixture()
  expect((await callJson(app, `/spaces/${space.id}/members`, {
    method: "POST", token: bob.token, body: { user_id: alice.id, role: "viewer" },
  })).status).toBe(422)
  expect((await callJson(app, `/spaces/${space.id}`, { token: alice.token })).body.my_role).toBe("admin")
})

test("a deleted Space cannot accept folders or member changes", async () => {
  const { alice, bob, space } = await fixture()
  await callJson(app, `/spaces/${space.id}`, { method: "DELETE", token: alice.token })
  expect((await callJson(app, `/spaces/${space.id}/folders`, {
    method: "POST", token: bob.token, body: { name: "Hidden" },
  })).status).toBe(404)
  expect((await callJson(app, `/spaces/${space.id}/members`, { token: bob.token })).status).toBe(404)
})

test("deleting an uploader preserves Space folders, files and blobs", async () => {
  const { alice, bob, folder, file } = await fixture()
  await purgeUser(db, fakeStore, bob.id)
  expect((await callJson(app, `/folders/${folder.id}`, { token: alice.token })).status).toBe(200)
  const download = await callJson(app, `/files/${file.id}/download`, { token: alice.token })
  expect(download.status).toBe(200)
  expect(download.body).toBe("secret memorandum")
  expect((await db.one(from("files").where(q => q("id").equals(file.id)))).user_id).toBe(alice.id)
})

test("deleting a Space owner transfers ownership and preserves shared content", async () => {
  const { alice, bob, space, folder, file } = await fixture()
  await purgeUser(db, fakeStore, alice.id)
  const transferred = await callJson(app, `/spaces/${space.id}`, { token: bob.token })
  expect(transferred.status).toBe(200)
  expect(transferred.body.owner_id).toBe(bob.id)
  expect(transferred.body.my_role).toBe("admin")
  expect((await callJson(app, `/folders/${folder.id}`, { token: bob.token })).status).toBe(200)
  expect((await callJson(app, `/files/${file.id}/download`, { token: bob.token })).status).toBe(200)
})

test("the last member's account can be purged with its abandoned Spaces", async () => {
  const { alice, bob, space } = await fixture()
  await purgeUser(db, fakeStore, bob.id)
  await purgeUser(db, fakeStore, alice.id)
  expect(await db.one(from("spaces").where(q => q("id").equals(space.id)))).toBeNull()
  expect(await db.one(from("users").where(q => q("id").equals(alice.id)))).toBeNull()
})

test("a revoked owner session cannot bypass burn-on-view", async () => {
  const { alice, file } = await fixture()
  const share = (await callJson(app, "/shares", {
    method: "POST", token: alice.token, body: { file_id: file.id, expires_in: 3600, burn_on_view: true },
  })).body
  const path = `/s/${share.token}`
  expect((await callJson(app, path, { token: alice.token })).status).toBe(200)
  expect((await callJson(app, path, { token: alice.token })).status).toBe(200)
  await db.execute(from("sessions").where(q => q("user_id").equals(alice.id)).update({ revoked_at: new Date().toISOString() }))
  expect((await callJson(app, path, { token: alice.token })).status).toBe(200)
  expect((await callJson(app, path, { token: alice.token })).status).toBe(404)
})

test("removed Space members cannot edit their old comments", async () => {
  const { alice, bob, space, member, file } = await fixture()
  const comment = (await callJson(app, `/files/${file.id}/comments`, {
    method: "POST", token: bob.token, body: { body: "before removal" },
  })).body
  await callJson(app, `/spaces/${space.id}/members/${member.id}`, { method: "DELETE", token: alice.token })
  expect((await callJson(app, `/comments/${comment.id}`, {
    method: "PATCH", token: bob.token, body: { body: "after removal" },
  })).status).toBe(404)
  const comments = (await callJson(app, `/files/${file.id}/comments`, { token: alice.token })).body.comments
  expect(comments[0].body).toBe("before removal")
  // deleting one's own words remains available after leaving
  expect((await callJson(app, `/comments/${comment.id}`, { method: "DELETE", token: bob.token })).status).toBe(200)
})

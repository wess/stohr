import { randomUUID } from "node:crypto"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { beforeEach, expect, test } from "bun:test"
import { authRoutes } from "../src/auth/index.ts"
import { federationFilesRoutes } from "../src/federation/files.ts"
import { federationFolderRoutes } from "../src/federation/folders.ts"
import { federationRoutes } from "../src/federation/index.ts"
import { sha256Hex } from "../src/federation/crypto.ts"
import { generateEd25519, generateX25519, signEd25519 } from "../src/federation/keys.ts"
import { buildSigningString } from "../src/federation/transport.ts"
import { SETTING_FEDERATION_ENABLED, seedIfMissing } from "../src/settings/index.ts"
import { callJson, fakeStore } from "./helpers/http.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

const app = router(...authRoutes(db, TEST_SECRET), ...federationRoutes(db, TEST_SECRET, "https://home.test"), ...federationFolderRoutes(db, TEST_SECRET), ...federationFilesRoutes(db, TEST_SECRET, fakeStore))

beforeEach(async () => {
  await truncateAll()
  await db.execute({ text: "TRUNCATE federations, federation_nonces RESTART IDENTITY CASCADE", values: [] })
  await seedIfMissing(db, SETTING_FEDERATION_ENABLED, true)
})

const fixture = async () => {
  const owner = await callJson(app, "/signup", { method: "POST", body: { name: "Owner", username: "owner", email: "owner@x.test", password: "password123" } })
  expect(owner.status).toBe(201)
  const fed = await callJson(app, "/me/federations", { method: "POST", token: owner.body.token, body: { slug: "alpha", name: "Alpha", type: "content-sharing" } })
  expect(fed.status).toBe(201)
  return { owner: owner.body, fed: fed.body }
}

test("federation mount refuses private and Space parent IDs", async () => {
  const { owner, fed } = await fixture()
  const others = await db.execute(from("users").insert({ name: "Other", username: "other", email: "other@x.test", password: "unused" }).returning("id")) as Array<{ id: number }>
  const privateFolders = await db.execute(from("folders").insert({ name: "Private", user_id: others[0]!.id }).returning("id")) as Array<{ id: number }>
  const spaces = await db.execute(from("spaces").insert({ slug: "editorial", name: "Editorial", owner_id: owner.id }).returning("id")) as Array<{ id: number }>
  await db.execute(from("space_members").insert({ space_id: spaces[0]!.id, user_id: owner.id, role: "admin" }))
  const spaceFolders = await db.execute(from("folders").insert({ name: "Space", user_id: owner.id, space_id: spaces[0]!.id }).returning("id")) as Array<{ id: number }>
  for (const parentId of [privateFolders[0]!.id, spaceFolders[0]!.id]) {
    const res = await callJson(app, `/me/federations/${fed.id}/folders/mount`, { method: "POST", token: owner.token, body: { parent_id: parentId } })
    expect(res.status).toBe(404)
  }
  const mount = await db.one(from("folders").where(q => q("federation_role").equals("mount")))
  expect(mount).toBeNull()
})

test("same blob ID in separate federations stores independent bytes", async () => {
  const { owner, fed } = await fixture()
  const otherFed = await callJson(app, "/me/federations", { method: "POST", token: owner.token, body: { slug: "beta", name: "Beta", type: "content-sharing" } })
  expect(otherFed.status).toBe(201)
  const peer = generateEd25519()
  for (const federation of [fed, otherFed.body]) {
    await db.execute(from("federation_members").insert({ federation_id: federation.id, peer_pubkey: peer.publicRaw, peer_x25519_pubkey: generateX25519().publicRaw, peer_base_url: "https://peer.test", is_local: false, status: "active" }))
    await db.execute(from("folders").insert({ user_id: owner.id, name: federation.slug, federation_id: federation.id, federation_role: "contribution", federation_quota_bytes: 100000 }))
    await db.execute(from("federation_members").where(q => q("federation_id").equals(federation.id)).where(q => q("is_local").equals(true)).update({ contributed_bytes: 100000 }))
  }
  const blobId = randomUUID()
  const keys: string[] = []
  for (const [slug, value] of [["alpha", "first content"], ["beta", "second content"]]) {
    const body = new TextEncoder().encode(value)
    const path = `/federation/blob/${slug}/${blobId}`
    const ts = Math.floor(Date.now() / 1000)
    const nonce = randomUUID()
    const sha = sha256Hex(body)
    const headers = { "x-fed-pubkey": peer.publicRaw, "x-fed-ts": String(ts), "x-fed-nonce": nonce, "x-fed-body-sha": sha, "x-fed-sig": signEd25519(peer.privatePem, buildSigningString("POST", path, ts, nonce, sha)), "x-fed-owner-pubkey": peer.publicRaw, "x-fed-size": String(body.length) }
    const res = await app(new Request(`http://test.local${path}`, { method: "POST", headers, body }))
    expect(res.status).toBe(200)
    const row = await db.one({ text: "SELECT b.local_storage_key FROM federation_blobs b JOIN federations f ON f.id = b.federation_id WHERE f.slug = $1 AND b.blob_id = $2", values: [slug, blobId] }) as { local_storage_key: string }
    keys.push(row.local_storage_key)
    expect(await (await fakeStore.get(row.local_storage_key)).text()).toBe(value)
  }
  expect(keys[0]).not.toBe(keys[1])
  expect(await (await fakeStore.get(keys[0]!)).text()).toBe("first content")
})

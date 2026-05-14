import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { computeUsage, checkQuota } from "../src/usage/index.ts"
import { sha256Hex } from "../src/util/token.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const seedFirstOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  return res.body as { id: number; token: string; is_owner: boolean }
}

const mintInvite = async (ownerId: number, email?: string): Promise<string> => {
  const t = `invitetoken-${Math.random().toString(36).slice(2, 12)}`
  await db.execute(
    from("invites").insert({
      token_hash: sha256Hex(t),
      email: email ?? null,
      invited_by: ownerId,
    }),
  )
  return t
}

const signupInvited = async (ownerId: number, name: string) => {
  const inviteToken = await mintInvite(ownerId)
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: {
      name,
      username: name.toLowerCase(),
      email: `${name.toLowerCase()}@example.com`,
      password: "password123",
      invite_token: inviteToken,
    },
  })
  return res.body as { id: number; token: string; is_owner: boolean }
}

describe("signup quota defaults", () => {
  test("first user (owner) starts unlimited (quota = 0)", async () => {
    const owner = await seedFirstOwner()
    expect(owner.is_owner).toBe(true)
    const row = await db.one(
      from("users").where(q => q("id").equals(owner.id)).select("storage_quota_bytes"),
    ) as { storage_quota_bytes: string } | null
    expect(Number(row?.storage_quota_bytes)).toBe(0)
  })

  test("invited user also starts unlimited — the owner sets caps later", async () => {
    const owner = await seedFirstOwner()
    const bob = await signupInvited(owner.id, "Bob")
    expect(bob.is_owner).toBe(false)
    const row = await db.one(
      from("users").where(q => q("id").equals(bob.id)).select("storage_quota_bytes"),
    ) as { storage_quota_bytes: string } | null
    expect(Number(row?.storage_quota_bytes)).toBe(0)
  })

  test("checkQuota with quota = 0 means unlimited", async () => {
    const owner = await seedFirstOwner()
    const tenTb = 10 * 1024 ** 4
    const r = await checkQuota(db, owner.id, 0, tenTb)
    expect(r.ok).toBe(true)
  })
})

describe("usage breakdown", () => {
  const seedFile = async (userId: number, opts: { size: number; deleted?: boolean }) => {
    const inserted = await db.execute(
      from("files").insert({
        user_id: userId,
        folder_id: null,
        name: `f-${Math.random().toString(36).slice(2, 8)}`,
        mime: "text/plain",
        size: opts.size,
        storage_key: `u${userId}/k/${Math.random()}`,
        deleted_at: opts.deleted ? new Date().toISOString() : null,
      }).returning("id"),
    ) as Array<{ id: number }>
    return inserted[0]!.id
  }

  const seedVersion = async (fileId: number, size: number) => {
    await db.execute(
      from("file_versions").insert({
        file_id: fileId,
        version: 1,
        mime: "text/plain",
        size,
        storage_key: `versions/${Math.random()}`,
      }),
    )
  }

  test("computeUsage splits active, trash, and versions", async () => {
    const owner = await seedFirstOwner()
    const f1 = await seedFile(owner.id, { size: 1000 })
    await seedFile(owner.id, { size: 500, deleted: true })
    await seedVersion(f1, 750)

    const u = await computeUsage(db, owner.id)
    expect(u.active).toBe(1000)
    expect(u.trash).toBe(500)
    expect(u.versions).toBe(750)
    expect(u.total).toBe(2250)
  })

  test("checkQuota counts trash + versions toward the cap", async () => {
    const owner = await seedFirstOwner()
    const f1 = await seedFile(owner.id, { size: 800 })
    await seedFile(owner.id, { size: 600, deleted: true })
    await seedVersion(f1, 400)
    // Total used = 1800. Cap = 2000. Incoming 100 → fits (1900). Incoming 250 → exceeds (2050).
    const allowed = await checkQuota(db, owner.id, 2000, 100)
    expect(allowed.ok).toBe(true)

    const blocked = await checkQuota(db, owner.id, 2000, 250)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.used_bytes).toBe(1800)
      expect(blocked.attempted_bytes).toBe(250)
      expect(blocked.breakdown.trash).toBe(600)
      expect(blocked.breakdown.versions).toBe(400)
    }
  })
})

describe("/me/usage", () => {
  test("returns the breakdown alongside the cap", async () => {
    const owner = await seedFirstOwner()
    await db.execute(
      from("files").insert({
        user_id: owner.id,
        folder_id: null,
        name: "live.txt",
        mime: "text/plain",
        size: 100,
        storage_key: "u/x",
      }),
    )
    const res = await callJson(app, "/me/usage", { token: owner.token })
    expect(res.status).toBe(200)
    expect(res.body.quota_bytes).toBe(0)
    expect(res.body.used_bytes).toBe(100)
    expect(res.body.active_bytes).toBe(100)
    expect(res.body.trash_bytes).toBe(0)
    expect(res.body.version_bytes).toBe(0)
  })
})

describe("admin storage caps", () => {
  test("owner can set a per-user cap, and it is then enforced", async () => {
    const owner = await seedFirstOwner()
    const capped = await signupInvited(owner.id, "Capped")

    const set = await callJson(app, `/admin/users/${capped.id}/quota`, {
      method: "POST",
      token: owner.token,
      body: { quota_bytes: 1000 },
    })
    expect(set.status).toBe(200)
    expect(set.body.quota_bytes).toBe(1000)

    const row = await db.one(
      from("users").where(q => q("id").equals(capped.id)).select("storage_quota_bytes"),
    ) as { storage_quota_bytes: string } | null
    expect(Number(row?.storage_quota_bytes)).toBe(1000)

    // 900 stored against a 1000 cap → another 200 should be rejected.
    await db.execute(
      from("files").insert({
        user_id: capped.id,
        folder_id: null,
        name: "big.bin",
        mime: "application/octet-stream",
        size: 900,
        storage_key: "u/big",
      }),
    )
    const blocked = await checkQuota(db, capped.id, 1000, 200)
    expect(blocked.ok).toBe(false)
  })

  test("a negative quota is rejected", async () => {
    const owner = await seedFirstOwner()
    const res = await callJson(app, `/admin/users/${owner.id}/quota`, {
      method: "POST",
      token: owner.token,
      body: { quota_bytes: -1 },
    })
    expect(res.status).toBe(422)
  })

  test("a non-owner cannot set quotas", async () => {
    const owner = await seedFirstOwner()
    const plain = await signupInvited(owner.id, "Plain")
    const res = await callJson(app, `/admin/users/${owner.id}/quota`, {
      method: "POST",
      token: plain.token,
      body: { quota_bytes: 0 },
    })
    expect(res.status).toBe(403)
  })
})

import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { folderAccess } from "../permissions/index.ts"
import { requireSettingEnabled, SETTING_FEDERATION_ENABLED } from "../settings/index.ts"
import { federationById, localMemberFor } from "./membership.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const MIN_QUOTA = 100 * 1024 * 1024 // 100 MB floor
const MAX_QUOTA = 1024 * 1024 * 1024 * 1024 * 10 // 10 TB ceiling

type ContributeBody = {
  quota_bytes?: number
}

type MountBody = {
  name?: string
  parent_id?: number | null
}

type EnsureMemberOk = {
  ok: true
  fed: NonNullable<Awaited<ReturnType<typeof federationById>>>
  member: NonNullable<Awaited<ReturnType<typeof localMemberFor>>>
}
type EnsureMemberErr = { ok: false; status: number; body: { error: string } }

const ensureMember = async (
  db: Connection,
  federationId: number,
  userId: number,
): Promise<EnsureMemberOk | EnsureMemberErr> => {
  const fed = await federationById(db, federationId)
  if (!fed) return { ok: false, status: 404, body: { error: "Federation not found" } }
  const member = await localMemberFor(db, federationId, userId)
  if (!member) return { ok: false, status: 404, body: { error: "Federation not found" } }
  return { ok: true, fed, member }
}

export const federationFolderRoutes = (db: Connection, secret: string) => {
  const gate = requireSettingEnabled(db, SETTING_FEDERATION_ENABLED)
  const guard = pipeline(gate, requireAuth({ secret, db, noOAuth: true }))
  const authed = pipeline(gate, requireAuth({ secret, db, noOAuth: true }), parseJson)

  return [
    // Designate an existing folder as the user's contribution mount-point
    // for this federation. The folder must already exist, be owned by the
    // user, and not already be tied to a different federation.
    post(
      "/me/federations/:id/folders/:folder_id/contribute",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const folderId = Number(c.params.folder_id)
        const body = c.body as ContributeBody
        const quotaBytes = Number(body.quota_bytes ?? 0)
        if (!Number.isFinite(quotaBytes) || quotaBytes < MIN_QUOTA || quotaBytes > MAX_QUOTA) {
          return json(c, 422, { error: `quota_bytes must be ${MIN_QUOTA}-${MAX_QUOTA}` })
        }

        const ctx = await ensureMember(db, id, userId)
        if (!ctx.ok) return json(c, ctx.status, ctx.body)

        const access = await folderAccess(db, userId, folderId)
        if (!access || access.folder.user_id !== userId) {
          return json(c, 404, { error: "Folder not found" })
        }
        if (access.folder.federation_id && access.folder.federation_id !== id) {
          return json(c, 409, { error: "Folder is already tied to a different federation" })
        }

        // Enforce one contribution folder per user-per-federation. The
        // partial unique index in the migration enforces this at the DB
        // layer too, but checking here gives a friendlier error.
        const existing = (await db.one(
          from("folders")
            .where(q => q("user_id").equals(userId))
            .where(q => q("federation_id").equals(id))
            .where(q => q("federation_role").equals("contribution"))
            .where(q => q("deleted_at").isNull())
            .select("id"),
        )) as { id: number } | null
        if (existing && existing.id !== folderId) {
          return json(c, 409, {
            error: "Already have a contribution folder for this federation",
            folder_id: existing.id,
          })
        }

        await db.execute(
          from("folders")
            .where(q => q("id").equals(folderId))
            .update({
              federation_id: id,
              federation_role: "contribution",
              federation_quota_bytes: quotaBytes,
            }),
        )
        await db.execute(
          from("federation_members")
            .where(q => q("id").equals(ctx.member.id))
            .update({
              contributed_bytes: quotaBytes,
            }),
        )

        return json(c, 200, { folder_id: folderId, federation_id: id, quota_bytes: quotaBytes })
      }),
    ),

    patch(
      "/me/federations/:id/folders/:folder_id/contribute",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const folderId = Number(c.params.folder_id)
        const body = c.body as ContributeBody
        const quotaBytes = Number(body.quota_bytes ?? 0)
        if (!Number.isFinite(quotaBytes) || quotaBytes < MIN_QUOTA || quotaBytes > MAX_QUOTA) {
          return json(c, 422, { error: `quota_bytes must be ${MIN_QUOTA}-${MAX_QUOTA}` })
        }

        const ctx = await ensureMember(db, id, userId)
        if (!ctx.ok) return json(c, ctx.status, ctx.body)

        const folder = (await db.one(
          from("folders")
            .where(q => q("id").equals(folderId))
            .where(q => q("user_id").equals(userId))
            .where(q => q("federation_id").equals(id))
            .where(q => q("federation_role").equals("contribution"))
            .where(q => q("deleted_at").isNull()),
        )) as { id: number; federation_quota_bytes: number | string } | null
        if (!folder) return json(c, 404, { error: "Contribution folder not found" })

        // Refuse to shrink below current used_bytes — the data already placed
        // here couldn't fit otherwise.
        const used = Number(ctx.member.used_bytes)
        if (quotaBytes < used) {
          return json(c, 422, { error: "Cannot shrink quota below current usage", used_bytes: used })
        }

        await db.execute(
          from("folders")
            .where(q => q("id").equals(folderId))
            .update({ federation_quota_bytes: quotaBytes }),
        )
        await db.execute(
          from("federation_members")
            .where(q => q("id").equals(ctx.member.id))
            .update({ contributed_bytes: quotaBytes }),
        )
        return json(c, 200, { folder_id: folderId, quota_bytes: quotaBytes })
      }),
    ),

    del(
      "/me/federations/:id/folders/:folder_id/contribute",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const folderId = Number(c.params.folder_id)

        const ctx = await ensureMember(db, id, userId)
        if (!ctx.ok) return json(c, ctx.status, ctx.body)

        const used = Number(ctx.member.used_bytes)
        if (used > 0) {
          return json(c, 409, {
            error: "Cannot remove contribution while hosting data. Leave the federation to drain first.",
            used_bytes: used,
          })
        }

        const folder = (await db.one(
          from("folders")
            .where(q => q("id").equals(folderId))
            .where(q => q("user_id").equals(userId))
            .where(q => q("federation_id").equals(id))
            .where(q => q("federation_role").equals("contribution"))
            .where(q => q("deleted_at").isNull()),
        )) as { id: number } | null
        if (!folder) return json(c, 404, { error: "Contribution folder not found" })

        await db.execute(
          from("folders")
            .where(q => q("id").equals(folderId))
            .update({
              federation_id: null,
              federation_role: null,
              federation_quota_bytes: 0,
            }),
        )
        await db.execute(
          from("federation_members")
            .where(q => q("id").equals(ctx.member.id))
            .update({ contributed_bytes: 0 }),
        )
        return json(c, 200, { released: folderId })
      }),
    ),

    // Content-sharing federations expose a virtual "mount" folder — a
    // normal folder marked with federation_role = 'mount' that the UI
    // treats as showing federation pool contents. Files uploaded here are
    // replicated to peers (see Phase 3). At most one mount per user-fed
    // tuple; reusing an existing mount returns 200.
    post(
      "/me/federations/:id/folders/mount",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = c.body as MountBody

        const ctx = await ensureMember(db, id, userId)
        if (!ctx.ok) return json(c, ctx.status, ctx.body)

        if (ctx.fed.type !== "content-sharing") {
          return json(c, 422, { error: "Mount folders only apply to content-sharing federations" })
        }

        const existing = (await db.one(
          from("folders")
            .where(q => q("user_id").equals(userId))
            .where(q => q("federation_id").equals(id))
            .where(q => q("federation_role").equals("mount"))
            .where(q => q("deleted_at").isNull())
            .select("id", "name"),
        )) as { id: number; name: string } | null
        if (existing) return json(c, 200, { folder_id: existing.id, name: existing.name })

        const name = (body.name ?? `${ctx.fed.name} (federation)`).trim()
        const parentId = body.parent_id == null ? null : Number(body.parent_id)
        const inserted = (await db.execute(
          from("folders")
            .insert({
              user_id: userId,
              parent_id: parentId,
              name,
              kind: "standard",
              is_public: false,
              federation_id: id,
              federation_role: "mount",
              federation_quota_bytes: 0,
            })
            .returning("id", "name"),
        )) as Array<{ id: number; name: string }>

        return json(c, 201, { folder_id: inserted[0]!.id, name: inserted[0]!.name })
      }),
    ),

    get(
      "/me/federations/:id/usage",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const ctx = await ensureMember(db, id, userId)
        if (!ctx.ok) return json(c, ctx.status, ctx.body)

        const contributed = Number(ctx.member.contributed_bytes)
        const used = Number(ctx.member.used_bytes)
        const multiplier = Number(ctx.fed.quota_multiplier) || 1
        const allowance = Math.floor(contributed * multiplier)

        return json(c, 200, {
          federation_id: id,
          contributed_bytes: contributed,
          used_bytes: used,
          quota_multiplier: multiplier,
          allowance_bytes: allowance,
          available_bytes: Math.max(0, allowance - used),
        })
      }),
    ),
  ]
}

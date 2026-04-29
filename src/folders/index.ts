import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { drop } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { canWrite, folderAccess, isOwner } from "../permissions/index.ts"
import type { FolderRow } from "../permissions/index.ts"
import { fireEvent } from "../actions/dispatch.ts"
import type { RunSummary } from "../actions/dispatch.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const collectSubtreeAll = async (db: Connection, rootId: number): Promise<number[]> => {
  const ids = [rootId]
  const queue = [rootId]
  while (queue.length) {
    const pid = queue.shift()!
    const children = await db.all(
      from("folders")
        .where(q => q("parent_id").equals(pid))
        .select("id"),
    ) as Array<{ id: number }>
    for (const c of children) {
      ids.push(c.id)
      queue.push(c.id)
    }
  }
  return ids
}

const buildTrail = async (
  db: Connection,
  userId: number,
  folder: FolderRow,
): Promise<Array<{ id: number; name: string }>> => {
  const trail: Array<{ id: number; name: string }> = [{ id: folder.id, name: folder.name }]
  const isOwn = folder.user_id === userId
  let cursor: { id: number; parent_id: number | null; name: string } = folder
  while (cursor.parent_id) {
    if (!isOwn) {
      const directGrant = await db.one(
        from("collaborations")
          .where(q => q("resource_type").equals("folder"))
          .where(q => q("resource_id").equals(cursor.id))
          .where(q => q("user_id").equals(userId))
          .select("id"),
      )
      if (directGrant) break
    }
    const parent = await db.one(
      from("folders")
        .where(q => q("id").equals(cursor.parent_id!))
        .where(q => q("deleted_at").isNull())
        .select("id", "parent_id", "name"),
    ) as { id: number; parent_id: number | null; name: string } | null
    if (!parent) break
    trail.unshift({ id: parent.id, name: parent.name })
    cursor = parent
  }
  return trail
}

export const folderRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/folders", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const parentRaw = url.searchParams.get("parent_id") ?? url.searchParams.get("parentId")
      const parentId = parentRaw === null || parentRaw === "" || parentRaw === "null" ? null : Number(parentRaw)

      if (parentId === null) {
        const rows = await db.all(
          from("folders")
            .where(q => q("user_id").equals(userId))
            .where(q => q("deleted_at").isNull())
            .where(q => q("parent_id").isNull())
            .orderBy("name", "ASC"),
        )
        return json(c, 200, rows)
      }

      const access = await folderAccess(db, userId, parentId)
      if (!access) return json(c, 404, { error: "Folder not found" })

      const rows = await db.all(
        from("folders")
          .where(q => q("parent_id").equals(parentId))
          .where(q => q("deleted_at").isNull())
          .orderBy("name", "ASC"),
      )

      return json(c, 200, rows)
    })),

    get("/folders/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })

      const trail = await buildTrail(db, userId, access.folder)
      const owner = await db.one(
        from("users").where(q => q("id").equals(access.folder.user_id)).select("id", "username", "name"),
      )

      return json(c, 200, { ...access.folder, trail, role: access.role, owner })
    })),

    post("/folders", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { name: string; parent_id?: number | null; parentId?: number | null; kind?: string; is_public?: boolean; isPublic?: boolean }
      const name = body.name
      const parentId = body.parent_id ?? body.parentId ?? null
      const kind = body.kind === "photos" ? "photos"
        : body.kind === "screenshots" ? "screenshots"
        : "standard"
      const isPublic = body.is_public ?? body.isPublic ?? false
      if (!name || !name.trim()) return json(c, 422, { error: "Name required" })

      let ownerId = userId
      let parentFolder: FolderRow | null = null
      if (parentId != null) {
        const access = await folderAccess(db, userId, parentId)
        if (!access) return json(c, 404, { error: "Parent folder not found" })
        if (!canWrite(access.role)) return json(c, 403, { error: "You don't have permission to add to this folder" })
        ownerId = access.folder.user_id
        parentFolder = access.folder
      }

      const rows = await db.execute(
        from("folders")
          .insert({ user_id: ownerId, parent_id: parentId, name: name.trim(), kind, is_public: isPublic })
          .returning("id", "name", "parent_id", "kind", "is_public", "created_at"),
      )

      const summaries: RunSummary[] = []
      if (parentFolder) {
        const fresh = await db.one(
          from("folders").where(q => q("id").equals(rows[0].id)),
        ) as FolderRow | null
        if (fresh) {
          summaries.push(...await fireEvent({
            db, store, event: "folder.created",
            folder: parentFolder, subject: { kind: "folder", row: fresh },
            actor: { id: userId },
          }))
        }
      }

      const out: Record<string, unknown> = { ...rows[0] }
      if (summaries.length > 0) out.action_results = summaries
      return json(c, 201, out)
    })),

    patch("/folders/:id", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const body = c.body as { name?: string; parent_id?: number | null; parentId?: number | null; kind?: string; is_public?: boolean; isPublic?: boolean }
      const hasName = typeof body.name === "string"
      const hasParent = body.parent_id !== undefined || body.parentId !== undefined
      const hasKind = typeof body.kind === "string"
      const hasPublic = body.is_public !== undefined || body.isPublic !== undefined
      if (!hasName && !hasParent && !hasKind && !hasPublic) return json(c, 422, { error: "Nothing to update" })

      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })
      if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })
      if ((hasKind || hasPublic) && !isOwner(access.role)) {
        return json(c, 403, { error: "Only the owner can change folder type or public access" })
      }

      const oldParentId = access.folder.parent_id
      let newParentId: number | null = oldParentId
      let newParentFolder: FolderRow | null = null

      const patchData: Record<string, unknown> = {}
      if (hasName) {
        const name = body.name!.trim()
        if (!name) return json(c, 422, { error: "Name required" })
        patchData.name = name
      }
      if (hasKind) {
        const k = body.kind!
        if (k !== "standard" && k !== "photos" && k !== "screenshots") return json(c, 422, { error: "Invalid kind" })
        patchData.kind = k
      }
      if (hasPublic) {
        patchData.is_public = !!(body.is_public ?? body.isPublic)
      }
      if (hasParent) {
        const rawParent = body.parent_id !== undefined ? body.parent_id : body.parentId
        const parentId = rawParent === null ? null : Number(rawParent)
        if (parentId === id) return json(c, 422, { error: "Cannot move folder into itself" })

        if (parentId === null) {
          if (!isOwner(access.role)) return json(c, 403, { error: "Only the owner can move a folder to the root" })
        } else {
          const subtree = await collectSubtreeAll(db, id)
          if (subtree.includes(parentId)) return json(c, 422, { error: "Cannot move folder into its own subtree" })
          const targetAccess = await folderAccess(db, userId, parentId)
          if (!targetAccess) return json(c, 404, { error: "Target folder not found" })
          if (!canWrite(targetAccess.role)) return json(c, 403, { error: "No write access on target" })
          if (targetAccess.folder.user_id !== access.folder.user_id) {
            return json(c, 422, { error: "Cannot move folder across owners" })
          }
          newParentFolder = targetAccess.folder
        }
        patchData.parent_id = parentId
        newParentId = parentId
      }

      await db.execute(
        from("folders").where(q => q("id").equals(id)).update(patchData),
      )

      const updatedFolder = await db.one(
        from("folders").where(q => q("id").equals(id)),
      ) as FolderRow | null

      const summaries: RunSummary[] = []
      if (updatedFolder) {
        const moved = hasParent && oldParentId !== newParentId
        if (moved) {
          if (oldParentId != null) {
            const oldParent = await db.one(
              from("folders").where(q => q("id").equals(oldParentId)).where(q => q("deleted_at").isNull()),
            ) as FolderRow | null
            if (oldParent) {
              summaries.push(...await fireEvent({
                db, store, event: "folder.moved.out",
                folder: oldParent, subject: { kind: "folder", row: updatedFolder },
                actor: { id: userId },
              }))
            }
          }
          if (newParentFolder) {
            summaries.push(...await fireEvent({
              db, store, event: "folder.moved.in",
              folder: newParentFolder, subject: { kind: "folder", row: updatedFolder },
              actor: { id: userId },
            }))
          }
        } else if (hasName && updatedFolder.parent_id != null) {
          const parent = await db.one(
            from("folders").where(q => q("id").equals(updatedFolder.parent_id)).where(q => q("deleted_at").isNull()),
          ) as FolderRow | null
          if (parent) {
            summaries.push(...await fireEvent({
              db, store, event: "folder.updated",
              folder: parent, subject: { kind: "folder", row: updatedFolder },
              actor: { id: userId },
            }))
          }
        }
      }

      const out: Record<string, unknown> = { id, ...patchData }
      if (summaries.length > 0) out.action_results = summaries
      return json(c, 200, out)
    })),

    del("/folders/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })
      if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })

      const folder = access.folder
      const ids = await collectSubtreeAll(db, id)

      for (const fid of ids) {
        await db.execute(
          from("folders").where(q => q("id").equals(fid)).update({ deleted_at: raw("NOW()") }),
        )
        await db.execute(
          from("files")
            .where(q => q("folder_id").equals(fid))
            .where(q => q("deleted_at").isNull())
            .update({ deleted_at: raw("NOW()") }),
        )
      }

      const summaries: RunSummary[] = []
      if (folder.parent_id != null) {
        const parent = await db.one(
          from("folders").where(q => q("id").equals(folder.parent_id)).where(q => q("deleted_at").isNull()),
        ) as FolderRow | null
        if (parent) {
          summaries.push(...await fireEvent({
            db, store, event: "folder.deleted",
            folder: parent, subject: { kind: "folder", row: folder },
            actor: { id: userId },
          }))
        }
      }

      const out: Record<string, unknown> = { trashed: id }
      if (summaries.length > 0) out.action_results = summaries
      return json(c, 200, out)
    })),

    post("/folders/:id/restore", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("folders").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)),
      ) as { id: number; parent_id: number | null; deleted_at: string | null } | null
      if (!row) return json(c, 404, { error: "Folder not found" })
      if (!row.deleted_at) return json(c, 200, { id })

      let newParentId: number | null = row.parent_id
      if (newParentId != null) {
        const parent = await db.one(
          from("folders").where(q => q("id").equals(newParentId)).where(q => q("deleted_at").isNull()),
        )
        if (!parent) newParentId = null
      }

      await db.execute(
        from("folders")
          .where(q => q("id").equals(id))
          .update({ deleted_at: null, parent_id: newParentId }),
      )

      return json(c, 200, { restored: id, parent_id: newParentId })
    })),

    del("/folders/:id/purge", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("folders").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)),
      )
      if (!row) return json(c, 404, { error: "Folder not found" })

      const ids = await collectSubtreeAll(db, id)

      const allFiles = await db.all(
        from("files").where(q => q("folder_id").inList(ids)).select("id", "storage_key", "thumb_key"),
      ) as Array<{ id: number; storage_key: string; thumb_key: string | null }>

      const fileIdList = allFiles.map(f => f.id).concat(-1)
      const allVersions = await db.all(
        from("file_versions").where(q => q("file_id").inList(fileIdList)).select("storage_key"),
      ) as Array<{ storage_key: string }>

      await db.execute(from("collaborations").where(q => q("resource_type").equals("file")).where(q => q("resource_id").inList(fileIdList)).del())
      await db.execute(from("collaborations").where(q => q("resource_type").equals("folder")).where(q => q("resource_id").inList(ids)).del())
      await db.execute(from("shares").where(q => q("file_id").inList(fileIdList)).del())
      await db.execute(from("file_versions").where(q => q("file_id").inList(fileIdList)).del())
      await db.execute(from("files").where(q => q("folder_id").inList(ids)).del())
      await db.execute(from("folders").where(q => q("id").inList(ids)).del())

      const keys = [
        ...allFiles.map(f => f.storage_key),
        ...allFiles.filter(f => f.thumb_key).map(f => f.thumb_key as string),
        ...allVersions.map(v => v.storage_key),
      ]
      await Promise.allSettled(keys.map(k => drop(store, k)))

      return json(c, 200, { purged: id })
    })),
  ]
}

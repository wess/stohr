import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "@atlas/auth"
import { drop } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const collectSubtree = async (db: Connection, userId: number, rootId: number): Promise<number[]> => {
  const ids = [rootId]
  const queue = [rootId]
  while (queue.length) {
    const pid = queue.shift()!
    const children = await db.all(
      from("folders")
        .where(q => q("user_id").equals(userId))
        .where(q => q("parent_id").equals(pid))
        .select("id")
    ) as Array<{ id: number }>
    for (const c of children) {
      ids.push(c.id)
      queue.push(c.id)
    }
  }
  return ids
}

export const folderRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret }))
  const authed = pipeline(requireAuth({ secret }), parseJson)

  return [
    get("/folders", guard(async (c) => {
      const userId = authId(c)
      const parentRaw = new URL(c.request.url).searchParams.get("parent_id")
        ?? new URL(c.request.url).searchParams.get("parentId")
      const parentId = parentRaw === null || parentRaw === "" || parentRaw === "null" ? null : Number(parentRaw)

      const base = from("folders")
        .where(q => q("user_id").equals(userId))
        .where(q => q("deleted_at").isNull())

      const rows = await db.all(
        (parentId === null
          ? base.where(q => q("parent_id").isNull())
          : base.where(q => q("parent_id").equals(parentId))
        ).orderBy("name", "ASC")
      )

      return json(c, 200, rows)
    })),

    get("/folders/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("folders")
          .where(q => q("id").equals(id))
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNull())
      )
      if (!row) return json(c, 404, { error: "Folder not found" })

      const trail: Array<{ id: number; name: string }> = []
      let cursor: any = row
      while (cursor) {
        trail.unshift({ id: cursor.id, name: cursor.name })
        if (!cursor.parent_id) break
        cursor = await db.one(
          from("folders")
            .where(q => q("id").equals(cursor.parent_id))
            .where(q => q("user_id").equals(userId))
            .where(q => q("deleted_at").isNull())
        )
      }

      return json(c, 200, { ...row, trail })
    })),

    post("/folders", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { name: string; parent_id?: number | null; parentId?: number | null }
      const name = body.name
      const parentId = body.parent_id ?? body.parentId ?? null
      if (!name || !name.trim()) return json(c, 422, { error: "Name required" })

      if (parentId != null) {
        const parent = await db.one(
          from("folders")
            .where(q => q("id").equals(parentId))
            .where(q => q("user_id").equals(userId))
            .where(q => q("deleted_at").isNull())
        )
        if (!parent) return json(c, 404, { error: "Parent folder not found" })
      }

      const rows = await db.execute(
        from("folders")
          .insert({ user_id: userId, parent_id: parentId, name: name.trim() })
          .returning("id", "name", "parent_id", "created_at")
      )

      return json(c, 201, rows[0])
    })),

    patch("/folders/:id", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const body = c.body as { name?: string; parent_id?: number | null; parentId?: number | null }
      const hasName = typeof body.name === "string"
      const hasParent = body.parent_id !== undefined || body.parentId !== undefined
      if (!hasName && !hasParent) return json(c, 422, { error: "Nothing to update" })

      const row = await db.one(
        from("folders")
          .where(q => q("id").equals(id))
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNull())
      )
      if (!row) return json(c, 404, { error: "Folder not found" })

      const patchData: Record<string, unknown> = {}
      if (hasName) {
        const name = body.name!.trim()
        if (!name) return json(c, 422, { error: "Name required" })
        patchData.name = name
      }
      if (hasParent) {
        const rawParent = body.parent_id !== undefined ? body.parent_id : body.parentId
        const parentId = rawParent === null ? null : Number(rawParent)
        if (parentId === id) return json(c, 422, { error: "Cannot move folder into itself" })
        if (parentId != null) {
          const subtree = await collectSubtree(db, userId, id)
          if (subtree.includes(parentId)) return json(c, 422, { error: "Cannot move folder into its own subtree" })
          const parent = await db.one(
            from("folders")
              .where(q => q("id").equals(parentId))
              .where(q => q("user_id").equals(userId))
              .where(q => q("deleted_at").isNull())
          )
          if (!parent) return json(c, 404, { error: "Target folder not found" })
        }
        patchData.parent_id = parentId
      }

      await db.execute(
        from("folders").where(q => q("id").equals(id)).update(patchData)
      )

      return json(c, 200, { id, ...patchData })
    })),

    del("/folders/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("folders")
          .where(q => q("id").equals(id))
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNull())
      )
      if (!row) return json(c, 404, { error: "Folder not found" })

      const ids = await collectSubtree(db, userId, id)

      for (const fid of ids) {
        await db.execute(
          from("folders").where(q => q("id").equals(fid)).update({ deleted_at: raw("NOW()") })
        )
        await db.execute(
          from("files").where(q => q("folder_id").equals(fid)).where(q => q("deleted_at").isNull()).update({ deleted_at: raw("NOW()") })
        )
      }

      return json(c, 200, { trashed: id })
    })),

    post("/folders/:id/restore", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("folders").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId))
      ) as { id: number; parent_id: number | null; deleted_at: string | null } | null
      if (!row) return json(c, 404, { error: "Folder not found" })
      if (!row.deleted_at) return json(c, 200, { id })

      let newParentId: number | null = row.parent_id
      if (newParentId != null) {
        const parent = await db.one(
          from("folders").where(q => q("id").equals(newParentId)).where(q => q("deleted_at").isNull())
        )
        if (!parent) newParentId = null
      }

      await db.execute(
        from("folders")
          .where(q => q("id").equals(id))
          .update({ deleted_at: null, parent_id: newParentId })
      )

      return json(c, 200, { restored: id, parent_id: newParentId })
    })),

    del("/folders/:id/purge", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("folders").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId))
      )
      if (!row) return json(c, 404, { error: "Folder not found" })

      const ids = await collectSubtree(db, userId, id)

      const allFiles = await db.all(
        from("files").where(q => q("folder_id").inList(ids)).select("id", "storage_key", "thumb_key")
      ) as Array<{ id: number; storage_key: string; thumb_key: string | null }>

      const allVersions = await db.all(
        from("file_versions")
          .where(q => q("file_id").inList(allFiles.map(f => f.id).concat(-1)))
          .select("storage_key")
      ) as Array<{ storage_key: string }>

      await db.execute(from("shares").where(q => q("file_id").inList(allFiles.map(f => f.id).concat(-1))).del())
      await db.execute(from("file_versions").where(q => q("file_id").inList(allFiles.map(f => f.id).concat(-1))).del())
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

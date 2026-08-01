import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post, putHeader } from "@atlas/server"
import type { RunSummary } from "../actions/dispatch.ts"
import { fireEvent } from "../actions/dispatch.ts"
import { requireAuth } from "../auth/guard.ts"
import type { FolderRow } from "../permissions/index.ts"
import { canWrite, folderAccess, isOwner } from "../permissions/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop } from "../storage/index.ts"
import { pagingHeaders, parsePaging } from "../util/paging.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// All ids in the subtree rooted at rootId (inclusive). One recursive CTE
// regardless of depth or fan-out.
const collectSubtreeAll = async (db: Connection, rootId: number): Promise<number[]> => {
  const rows = (await db.execute({
    text: `
      WITH RECURSIVE sub AS (
        SELECT id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
      )
      SELECT id FROM sub
    `,
    values: [rootId],
  })) as Array<{ id: number }>
  return rows.map(r => r.id)
}

// Breadcrumbs for a folder. This walked the ancestry one level at a time,
// costing up to two round-trips per level on every folder open; the whole
// chain plus each node's grant flag now comes back in one query and the
// truncation happens in memory.
//
// Visibility rule (unchanged): an owner sees the full path to the root. A
// collaborator sees only as far up as the folder they were granted — the
// share root is the top of their world, and names above it aren't theirs
// to see.
const buildTrail = async (
  db: Connection,
  userId: number,
  folder: FolderRow,
): Promise<Array<{ id: number; name: string }>> => {
  const rows = (await db.execute({
    text: `
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, name, 0 AS depth
          FROM folders
         WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id, f.name, c.depth + 1
          FROM folders f
          JOIN chain c ON f.id = c.parent_id
         WHERE f.deleted_at IS NULL
           AND c.depth < 64
      )
      SELECT c.id,
             c.name,
             EXISTS (
               SELECT 1 FROM collaborations col
                WHERE col.resource_type = 'folder'
                  AND col.resource_id = c.id
                  AND col.user_id = $2
             ) AS granted
        FROM chain c
       ORDER BY c.depth ASC
    `,
    values: [folder.id, userId],
  })) as Array<{ id: number; name: string; granted: boolean }>

  const isOwn = folder.user_id === userId
  const trail: Array<{ id: number; name: string }> = []
  for (const row of rows) {
    trail.unshift({ id: row.id, name: row.name })
    // Stop once we reach the node this user was granted directly.
    if (!isOwn && row.granted) break
  }
  return trail
}

export const folderRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get(
      "/folders",
      guard(async c => {
        const userId = authId(c)
        const url = new URL(c.request.url)
        const parentRaw = url.searchParams.get("parent_id") ?? url.searchParams.get("parentId")
        const parentId = parentRaw === null || parentRaw === "" || parentRaw === "null" ? null : Number(parentRaw)

        // This listing had no limit at all — an account with a large number of
        // sibling folders serialized every one of them into a single response.
        const paging = parsePaging(url)
        const page = <T>(qb: T): T =>
          (qb as any).orderBy("name", "ASC").orderBy("id", "ASC").limit(paging.limit).offset(paging.offset)

        if (parentId === null) {
          const rows = await db.all(
            page(
              from("folders")
                .where(q => q("user_id").equals(userId))
                .where(q => q("deleted_at").isNull())
                .where(q => q("parent_id").isNull()),
            ),
          )
          return json(pagingHeaders(c, putHeader, paging, rows.length), 200, rows)
        }

        const access = await folderAccess(db, userId, parentId)
        if (!access) return json(c, 404, { error: "Folder not found" })

        const rows = await db.all(
          page(
            from("folders")
              .where(q => q("parent_id").equals(parentId))
              .where(q => q("deleted_at").isNull()),
          ),
        )

        return json(pagingHeaders(c, putHeader, paging, rows.length), 200, rows)
      }),
    ),

    get(
      "/folders/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const access = await folderAccess(db, userId, id)
        if (!access) return json(c, 404, { error: "Folder not found" })

        const trail = await buildTrail(db, userId, access.folder)
        const owner = await db.one(
          from("users")
            .where(q => q("id").equals(access.folder.user_id))
            .select("id", "username", "name"),
        )

        return json(c, 200, { ...access.folder, trail, role: access.role, owner })
      }),
    ),

    post(
      "/folders",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as {
          name: string
          parent_id?: number | null
          parentId?: number | null
          kind?: string
          is_public?: boolean
          isPublic?: boolean
        }
        const name = body.name
        const parentId = body.parent_id ?? body.parentId ?? null
        const kind = body.kind === "photos" ? "photos" : body.kind === "screenshots" ? "screenshots" : "standard"
        const isPublic = body.is_public ?? body.isPublic ?? false
        if (!name?.trim()) return json(c, 422, { error: "Name required" })

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
          const fresh = (await db.one(from("folders").where(q => q("id").equals(rows[0].id)))) as FolderRow | null
          if (fresh) {
            summaries.push(
              ...(await fireEvent({
                db,
                store,
                event: "folder.created",
                folder: parentFolder,
                subject: { kind: "folder", row: fresh },
                actor: { id: userId },
              })),
            )
          }
        }

        const out: Record<string, unknown> = { ...rows[0] }
        if (summaries.length > 0) out.action_results = summaries
        return json(c, 201, out)
      }),
    ),

    patch(
      "/folders/:id",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = c.body as {
          name?: string
          parent_id?: number | null
          parentId?: number | null
          kind?: string
          is_public?: boolean
          isPublic?: boolean
        }
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
            const targetAccess = await folderAccess(db, userId, parentId)
            if (!targetAccess) return json(c, 404, { error: "Target folder not found" })
            if (!canWrite(targetAccess.role)) return json(c, 403, { error: "No write access on target" })
            if (targetAccess.folder.user_id !== access.folder.user_id) {
              return json(c, 422, { error: "Cannot move folder across owners" })
            }
            // Cycle check is the expensive part — only walk the subtree once
            // every cheap rejection above has cleared.
            const subtree = await collectSubtreeAll(db, id)
            if (subtree.includes(parentId)) return json(c, 422, { error: "Cannot move folder into its own subtree" })
            newParentFolder = targetAccess.folder
          }
          patchData.parent_id = parentId
          newParentId = parentId
        }

        await db.execute(
          from("folders")
            .where(q => q("id").equals(id))
            .update(patchData),
        )

        const updatedFolder = (await db.one(from("folders").where(q => q("id").equals(id)))) as FolderRow | null

        const summaries: RunSummary[] = []
        if (updatedFolder) {
          const moved = hasParent && oldParentId !== newParentId
          if (moved) {
            if (oldParentId != null) {
              const oldParent = (await db.one(
                from("folders")
                  .where(q => q("id").equals(oldParentId))
                  .where(q => q("deleted_at").isNull()),
              )) as FolderRow | null
              if (oldParent) {
                summaries.push(
                  ...(await fireEvent({
                    db,
                    store,
                    event: "folder.moved.out",
                    folder: oldParent,
                    subject: { kind: "folder", row: updatedFolder },
                    actor: { id: userId },
                  })),
                )
              }
            }
            if (newParentFolder) {
              summaries.push(
                ...(await fireEvent({
                  db,
                  store,
                  event: "folder.moved.in",
                  folder: newParentFolder,
                  subject: { kind: "folder", row: updatedFolder },
                  actor: { id: userId },
                })),
              )
            }
          } else if (hasName && updatedFolder.parent_id != null) {
            const parent = (await db.one(
              from("folders")
                .where(q => q("id").equals(updatedFolder.parent_id))
                .where(q => q("deleted_at").isNull()),
            )) as FolderRow | null
            if (parent) {
              summaries.push(
                ...(await fireEvent({
                  db,
                  store,
                  event: "folder.updated",
                  folder: parent,
                  subject: { kind: "folder", row: updatedFolder },
                  actor: { id: userId },
                })),
              )
            }
          }
        }

        const out: Record<string, unknown> = { id, ...patchData }
        if (summaries.length > 0) out.action_results = summaries
        return json(c, 200, out)
      }),
    ),

    del(
      "/folders/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const access = await folderAccess(db, userId, id)
        if (!access) return json(c, 404, { error: "Folder not found" })
        if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })

        const folder = access.folder
        const ids = await collectSubtreeAll(db, id)

        await db.execute(
          from("folders")
            .where(q => q("id").inList(ids))
            .update({ deleted_at: raw("NOW()") }),
        )
        await db.execute(
          from("files")
            .where(q => q("folder_id").inList(ids))
            .where(q => q("deleted_at").isNull())
            .update({ deleted_at: raw("NOW()") }),
        )

        const summaries: RunSummary[] = []
        if (folder.parent_id != null) {
          const parent = (await db.one(
            from("folders")
              .where(q => q("id").equals(folder.parent_id))
              .where(q => q("deleted_at").isNull()),
          )) as FolderRow | null
          if (parent) {
            summaries.push(
              ...(await fireEvent({
                db,
                store,
                event: "folder.deleted",
                folder: parent,
                subject: { kind: "folder", row: folder },
                actor: { id: userId },
              })),
            )
          }
        }

        const out: Record<string, unknown> = { trashed: id }
        if (summaries.length > 0) out.action_results = summaries
        return json(c, 200, out)
      }),
    ),

    post(
      "/folders/:id/restore",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const row = (await db.one(
          from("folders")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(userId)),
        )) as { id: number; parent_id: number | null; deleted_at: string | null } | null
        if (!row) return json(c, 404, { error: "Folder not found" })
        if (!row.deleted_at) return json(c, 200, { id })

        let newParentId: number | null = row.parent_id
        if (newParentId != null) {
          const parent = await db.one(
            from("folders")
              .where(q => q("id").equals(newParentId))
              .where(q => q("deleted_at").isNull()),
          )
          if (!parent) newParentId = null
        }

        await db.execute(
          from("folders")
            .where(q => q("id").equals(id))
            .update({ deleted_at: null, parent_id: newParentId }),
        )

        return json(c, 200, { restored: id, parent_id: newParentId })
      }),
    ),

    del(
      "/folders/:id/purge",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const row = await db.one(
          from("folders")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(userId)),
        )
        if (!row) return json(c, 404, { error: "Folder not found" })

        const ids = await collectSubtreeAll(db, id)

        const allFiles = (await db.all(
          from("files")
            .where(q => q("folder_id").inList(ids))
            .select("id", "storage_key", "thumb_key"),
        )) as Array<{ id: number; storage_key: string; thumb_key: string | null }>

        const fileIdList = allFiles.map(f => f.id).concat(-1)
        const allVersions = (await db.all(
          from("file_versions")
            .where(q => q("file_id").inList(fileIdList))
            .select("storage_key"),
        )) as Array<{ storage_key: string }>

        await db.execute(
          from("collaborations")
            .where(q => q("resource_type").equals("file"))
            .where(q => q("resource_id").inList(fileIdList))
            .del(),
        )
        await db.execute(
          from("collaborations")
            .where(q => q("resource_type").equals("folder"))
            .where(q => q("resource_id").inList(ids))
            .del(),
        )
        await db.execute(
          from("shares")
            .where(q => q("file_id").inList(fileIdList))
            .del(),
        )
        await db.execute(
          from("file_versions")
            .where(q => q("file_id").inList(fileIdList))
            .del(),
        )
        await db.execute(
          from("files")
            .where(q => q("folder_id").inList(ids))
            .del(),
        )
        await db.execute(
          from("folders")
            .where(q => q("id").inList(ids))
            .del(),
        )

        const keys = [
          ...allFiles.map(f => f.storage_key),
          ...allFiles.filter(f => f.thumb_key).map(f => f.thumb_key as string),
          ...allVersions.map(v => v.storage_key),
        ]
        await Promise.allSettled(keys.map(k => drop(store, k)))

        return json(c, 200, { purged: id })
      }),
    ),
  ]
}

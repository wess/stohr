import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, pipeline } from "@atlas/server"
import { requireAuth } from "@atlas/auth"
import { drop } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const trashRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret }))

  return [
    get("/trash", guard(async (c) => {
      const userId = authId(c)

      const folders = await db.all(
        from("folders")
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNotNull())
          .select("id", "name", "parent_id", "deleted_at", "created_at")
          .orderBy("deleted_at", "DESC")
      )

      const files = await db.all(
        from("files")
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNotNull())
          .select("id", "name", "mime", "size", "folder_id", "version", "deleted_at", "created_at")
          .orderBy("deleted_at", "DESC")
      )

      return json(c, 200, { folders, files })
    })),

    del("/trash", guard(async (c) => {
      const userId = authId(c)

      const files = await db.all(
        from("files")
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNotNull())
          .select("id", "storage_key", "thumb_key")
      ) as Array<{ id: number; storage_key: string; thumb_key: string | null }>

      const folders = await db.all(
        from("folders")
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNotNull())
          .select("id")
      ) as Array<{ id: number }>

      const fileIds = files.map(f => f.id).concat(-1)
      const versions = await db.all(
        from("file_versions").where(q => q("file_id").inList(fileIds)).select("storage_key")
      ) as Array<{ storage_key: string }>

      const folderIds = folders.map(f => f.id).concat(-1)

      await db.execute(from("collaborations").where(q => q("resource_type").equals("file")).where(q => q("resource_id").inList(fileIds)).del())
      await db.execute(from("collaborations").where(q => q("resource_type").equals("folder")).where(q => q("resource_id").inList(folderIds)).del())
      await db.execute(from("shares").where(q => q("file_id").inList(fileIds)).del())
      await db.execute(from("file_versions").where(q => q("file_id").inList(fileIds)).del())
      await db.execute(
        from("files")
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNotNull())
          .del()
      )
      await db.execute(
        from("folders")
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNotNull())
          .del()
      )

      const keys = [
        ...files.map(f => f.storage_key),
        ...files.filter(f => f.thumb_key).map(f => f.thumb_key as string),
        ...versions.map(v => v.storage_key),
      ]
      await Promise.allSettled(keys.map(k => drop(store, k)))

      return json(c, 200, { purged_files: files.length, purged_folders: folders.length })
    })),
  ]
}

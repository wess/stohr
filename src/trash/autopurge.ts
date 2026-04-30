import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { drop } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { log } from "../log/index.ts"

// Hard-deletes files and folders that have been in the trash longer than
// TRASH_RETENTION_DAYS (default 30). Called from the recurring job
// "trash.autopurge". Cascades the same way as the manual /trash DELETE
// endpoint and the per-row /purge endpoints.
//
// One DB pass collects every storage key first, then deletes rows in
// FK-safe order, then drops storage objects best-effort. This matches the
// pattern in the rest of the codebase — DB consistency comes before storage
// cleanup, and storage failures are tolerated rather than blocking the API.

const RETENTION_DAYS = Math.max(1, Number(process.env.TRASH_RETENTION_DAYS ?? 30))

export const handleTrashAutoPurge = async (db: Connection, store: StorageHandle): Promise<void> => {
  const cutoffSql = `NOW() - interval '${RETENTION_DAYS} days'`

  const expiredFolders = await db.execute({
    text: `SELECT id FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffSql}`,
    values: [],
  }) as Array<{ id: number }>

  const expiredFiles = await db.execute({
    text: `SELECT id, storage_key, thumb_key FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoffSql}`,
    values: [],
  }) as Array<{ id: number; storage_key: string; thumb_key: string | null }>

  if (expiredFolders.length === 0 && expiredFiles.length === 0) return

  const folderIds = expiredFolders.map(f => f.id).concat(-1)
  const fileIds = expiredFiles.map(f => f.id).concat(-1)

  // Files inside expired folders that aren't already soft-deleted on
  // their own row need the same purge. Pull them in.
  const inFolderFiles = await db.all(
    from("files").where(q => q("folder_id").inList(folderIds)).select("id", "storage_key", "thumb_key"),
  ) as Array<{ id: number; storage_key: string; thumb_key: string | null }>

  const allFileIds = Array.from(new Set([...expiredFiles.map(f => f.id), ...inFolderFiles.map(f => f.id), -1]))
  const allFiles = [...expiredFiles, ...inFolderFiles.filter(f => !expiredFiles.find(e => e.id === f.id))]

  const versions = allFileIds.length > 0
    ? await db.all(
        from("file_versions").where(q => q("file_id").inList(allFileIds)).select("storage_key"),
      ) as Array<{ storage_key: string }>
    : []

  await db.execute(from("collaborations").where(q => q("resource_type").equals("file")).where(q => q("resource_id").inList(allFileIds)).del())
  await db.execute(from("collaborations").where(q => q("resource_type").equals("folder")).where(q => q("resource_id").inList(folderIds)).del())
  await db.execute(from("shares").where(q => q("file_id").inList(allFileIds)).del())
  await db.execute(from("file_versions").where(q => q("file_id").inList(allFileIds)).del())
  await db.execute(from("files").where(q => q("id").inList(allFileIds)).del())
  await db.execute(from("folders").where(q => q("id").inList(folderIds)).del())

  const keys = [
    ...allFiles.map(f => f.storage_key),
    ...allFiles.filter(f => f.thumb_key).map(f => f.thumb_key as string),
    ...versions.map(v => v.storage_key),
  ]
  await Promise.allSettled(keys.map(k => drop(store, k)))

  log.info("trash auto-purge", {
    folders: expiredFolders.length,
    files: allFiles.length,
    versions: versions.length,
    retention_days: RETENTION_DAYS,
  })
}

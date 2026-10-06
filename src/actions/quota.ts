import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { FileRow } from "../permissions/index.ts"
import { drop, type StorageHandle } from "../storage/index.ts"
import { quotaAfterWrite, quotaMessage } from "../uploads/quota.ts"
import { checkQuota, userQuota } from "../usage/index.ts"

export const checkActionQuota = async (db: Connection, ownerId: number, bytes: number): Promise<number> => {
  const quota = await userQuota(db, ownerId)
  const check = await checkQuota(db, ownerId, quota, bytes)
  if (!check.ok) throw new Error(quotaMessage(check.scope))
  return quota
}

export const finishActionWrite = async (
  db: Connection,
  store: StorageHandle,
  ownerId: number,
  quota: number,
  bytes: number,
  key: string,
  previous?: FileRow,
  thumbKey?: string | null,
): Promise<void> => {
  const over = await quotaAfterWrite(db, ownerId, quota, bytes)
  if (!over) return
  // only roll back our version; a subsequent writer may already own the row
  const query = from("files").where(q => q("storage_key").equals(key))
  const rows = (await db.execute(
    previous
      ? query
          .update({
            name: previous.name,
            mime: previous.mime,
            size: previous.size,
            storage_key: previous.storage_key,
            thumb_key: previous.thumb_key,
            version: previous.version,
            scan_status: previous.scan_status,
            scan_signature: previous.scan_signature,
            scanned_at: previous.scanned_at,
          })
          .returning("id")
      : query.del().returning("id"),
  )) as Array<{ id: number }>
  if (rows.length) {
    if (previous)
      await db.execute(
        from("file_versions")
          .where(q => q("file_id").equals(previous.id))
          .where(q => q("version").equals(previous.version))
          .del(),
      )
    await Promise.allSettled([drop(store, key), ...(thumbKey ? [drop(store, thumbKey)] : [])])
  }
  throw new Error(quotaMessage(over.scope))
}

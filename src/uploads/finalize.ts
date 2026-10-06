// Inserts (or versions) the files row once the assembled object exists in
// storage. This replicates the same key/thumb/versioning path the existing
// POST /files handler runs after put() — see src/files/index.ts. The shared
// helpers there (archiveCurrent, the version branch) are not exported, so the
// minimal equivalent is reproduced here.
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { clamdConfig } from "../scanning/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop, put } from "../storage/index.ts"
import { generateImageThumb, isThumbable, THUMB_MAX_BYTES, thumbKeyFor } from "../storage/thumb.ts"
import type { QuotaDenied } from "../usage/index.ts"
import { quotaAfterWrite } from "./quota.ts"

type FileRow = {
  id: number
  version: number
  mime: string
  size: number
  storage_key: string
  thumb_key: string | null
  scan_status: string
  scan_signature: string | null
  scanned_at: string | null
}

export type FinalizedFile = {
  id: number
  name: string
  mime: string
  size: number
  folder_id: number | null
  version: number
  created_at: string
  new_version: boolean
}

export type FinalizeResult = { ok: true; file: FinalizedFile } | QuotaDenied

// thumbBytes is the full object bytes when we already have them in memory
// (local driver concat path). For S3 we skip thumbnailing rather than
// re-downloading a freshly assembled multi-GB object — pass null.
//
// quotaBytes (0 = unlimited) and the owner's team cap are re-checked against
// live usage after the row is written, because the check at init raced with
// every other write since. On overflow the write is undone — row, version
// entry and blobs — and the caller gets the quota payload instead of a file.
export const finalizeUpload = async (
  db: Connection,
  store: StorageHandle,
  args: {
    ownerId: number
    folderId: number | null
    name: string
    mime: string
    size: number
    key: string
    thumbBytes: Uint8Array | null
    quotaBytes: number
  },
): Promise<FinalizeResult> => {
  const { ownerId, folderId, name, mime, size, key, thumbBytes, quotaBytes } = args

  let thumbKey: string | null = null
  if (thumbBytes && isThumbable(mime) && size <= THUMB_MAX_BYTES) {
    const thumb = await generateImageThumb(thumbBytes, mime)
    if (thumb) {
      thumbKey = thumbKeyFor(key)
      try {
        await put(store, thumbKey, thumb, "image/webp")
      } catch {
        thumbKey = null
      }
    }
  }

  // Fresh bytes get a fresh verdict — the row's status described the old ones.
  const scanStatus = clamdConfig() ? "pending" : "skipped"

  const existing =
    folderId === null
      ? ((await db.one(
          from("files")
            .where(q => q("user_id").equals(ownerId))
            .where(q => q("folder_id").isNull())
            .where(q => q("name").equals(name))
            .where(q => q("deleted_at").isNull()),
        )) as FileRow | null)
      : ((await db.one(
          from("files")
            .where(q => q("user_id").equals(ownerId))
            .where(q => q("folder_id").equals(folderId))
            .where(q => q("name").equals(name))
            .where(q => q("deleted_at").isNull()),
        )) as FileRow | null)

  const dropNew = () => Promise.allSettled([drop(store, key), ...(thumbKey ? [drop(store, thumbKey)] : [])])

  let fileId: number
  let isNewVersion: boolean
  let undo: () => Promise<void>
  let priorThumb: string | null = null
  if (existing) {
    const snapshot = { ...existing }
    await db.execute(
      from("file_versions").insert({
        file_id: existing.id,
        version: existing.version,
        mime: existing.mime,
        size: existing.size,
        storage_key: existing.storage_key,
        scan_status: existing.scan_status,
        scan_signature: existing.scan_signature,
        scanned_at: existing.scanned_at,
        uploaded_by: ownerId,
      }),
    )
    await db.execute(
      from("files")
        .where(q => q("id").equals(existing.id))
        .update({
          mime,
          size,
          storage_key: key,
          thumb_key: thumbKey,
          version: existing.version + 1,
          scan_status: scanStatus,
          scan_signature: null,
          scanned_at: null,
        }),
    )
    priorThumb = existing.thumb_key
    fileId = existing.id
    isNewVersion = true
    undo = async () => {
      await db.execute(
        from("file_versions")
          .where(q => q("file_id").equals(snapshot.id))
          .where(q => q("version").equals(snapshot.version))
          .del(),
      )
      await db.execute(
        from("files")
          .where(q => q("id").equals(snapshot.id))
          .update({
            mime: snapshot.mime,
            size: snapshot.size,
            storage_key: snapshot.storage_key,
            thumb_key: snapshot.thumb_key,
            version: snapshot.version,
            scan_status: snapshot.scan_status,
            scan_signature: snapshot.scan_signature,
            scanned_at: snapshot.scanned_at,
          }),
      )
      await dropNew()
    }
  } else {
    const rows = (await db.execute(
      from("files")
        .insert({
          user_id: ownerId,
          folder_id: folderId,
          name,
          mime,
          size,
          storage_key: key,
          thumb_key: thumbKey,
          version: 1,
          scan_status: scanStatus,
        })
        .returning("id"),
    )) as Array<{ id: number }>
    fileId = rows[0]!.id
    isNewVersion = false
    undo = async () => {
      await db.execute(
        from("files")
          .where(q => q("id").equals(fileId))
          .del(),
      )
      await dropNew()
    }
  }

  const over = await quotaAfterWrite(db, ownerId, quotaBytes, size)
  if (over) {
    await undo().catch(err => console.error("[uploads] quota rollback failed:", err))
    return over
  }

  // Only now is the old thumbnail unreferenced for good.
  if (priorThumb) await Promise.allSettled([drop(store, priorThumb)])

  const after = (await db.one(
    from("files")
      .where(q => q("id").equals(fileId))
      .select("id", "name", "mime", "size", "folder_id", "version", "created_at"),
  )) as Omit<FinalizedFile, "new_version"> | null

  if (!after) throw new Error(`finalizeUpload: files row ${fileId} vanished after write`)
  return { ok: true, file: { ...after, new_version: isNewVersion } }
}

// Inserts (or versions) the files row once the assembled object exists in
// storage. This replicates the same key/thumb/versioning path the existing
// POST /files handler runs after put() — see src/files/index.ts. The shared
// helpers there (archiveCurrent, the version branch) are not exported, so the
// minimal equivalent is reproduced here.
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { StorageHandle } from "../storage/index.ts"
import { drop, put } from "../storage/index.ts"
import { generateImageThumb, isThumbable, THUMB_MAX_BYTES, thumbKeyFor } from "../storage/thumb.ts"

type FileRow = {
  id: number
  version: number
  mime: string
  size: number
  storage_key: string
  thumb_key: string | null
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

// thumbBytes is the full object bytes when we already have them in memory
// (local driver concat path). For S3 we skip thumbnailing rather than
// re-downloading a freshly assembled multi-GB object — pass null.
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
  },
): Promise<FinalizedFile> => {
  const { ownerId, folderId, name, mime, size, key, thumbBytes } = args

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

  let fileId: number
  let isNewVersion: boolean
  if (existing) {
    await db.execute(
      from("file_versions").insert({
        file_id: existing.id,
        version: existing.version,
        mime: existing.mime,
        size: existing.size,
        storage_key: existing.storage_key,
        uploaded_by: ownerId,
      }),
    )
    const newVersion = existing.version + 1
    const priorThumb = existing.thumb_key
    await db.execute(
      from("files")
        .where(q => q("id").equals(existing.id))
        .update({ mime, size, storage_key: key, thumb_key: thumbKey, version: newVersion }),
    )
    if (priorThumb) await Promise.allSettled([drop(store, priorThumb)])
    fileId = existing.id
    isNewVersion = true
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
        })
        .returning("id"),
    )) as Array<{ id: number }>
    fileId = rows[0]!.id
    isNewVersion = false
  }

  const after = (await db.one(
    from("files")
      .where(q => q("id").equals(fileId))
      .select("id", "name", "mime", "size", "folder_id", "version", "created_at"),
  )) as Omit<FinalizedFile, "new_version"> | null

  if (!after) throw new Error(`finalizeUpload: files row ${fileId} vanished after write`)
  return { ...after, new_version: isNewVersion }
}

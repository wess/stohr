import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseMultipart, patch, pipeline, post, putHeader, stream } from "@atlas/server"
import { requireAuth } from "@atlas/auth"
import { drop, fetchObject, makeKey, put } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { generateImageThumb, isThumbable, thumbKeyFor } from "../storage/thumb.ts"
import { canWrite, fileAccess, folderAccess } from "../permissions/index.ts"
import type { FileRow } from "../permissions/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const archiveCurrent = async (db: Connection, file: FileRow, uploaderId: number) => {
  await db.execute(
    from("file_versions").insert({
      file_id: file.id,
      version: file.version,
      mime: file.mime,
      size: file.size,
      storage_key: file.storage_key,
      uploaded_by: uploaderId,
    }),
  )
}

export const fileRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret }))
  const upload = pipeline(requireAuth({ secret }), parseMultipart)

  return [
    get("/files", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const folderRaw = url.searchParams.get("folder_id") ?? url.searchParams.get("folderId")
      const q = url.searchParams.get("q")
      const folderId = folderRaw === null || folderRaw === "" || folderRaw === "null" ? null : Number(folderRaw)

      if (q) {
        const rows = await db.all(
          from("files")
            .where(p => p("user_id").equals(userId))
            .where(p => p("deleted_at").isNull())
            .where(p => p("name").ilike(`%${q}%`))
            .select("id", "name", "mime", "size", "folder_id", "version", "created_at")
            .orderBy("created_at", "DESC")
            .limit(200),
        )
        return json(c, 200, rows)
      }

      if (folderId === null) {
        const rows = await db.all(
          from("files")
            .where(p => p("user_id").equals(userId))
            .where(p => p("deleted_at").isNull())
            .where(p => p("folder_id").isNull())
            .select("id", "name", "mime", "size", "folder_id", "version", "created_at")
            .orderBy("created_at", "DESC")
            .limit(200),
        )
        return json(c, 200, rows)
      }

      const access = await folderAccess(db, userId, folderId)
      if (!access) return json(c, 404, { error: "Folder not found" })

      const rows = await db.all(
        from("files")
          .where(p => p("folder_id").equals(folderId))
          .where(p => p("deleted_at").isNull())
          .select("id", "name", "mime", "size", "folder_id", "version", "created_at")
          .orderBy("created_at", "DESC")
          .limit(200),
      )
      return json(c, 200, rows)
    })),

    get("/files/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      const f = access.file
      return json(c, 200, {
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
        folder_id: f.folder_id,
        version: f.version,
        created_at: f.created_at,
        role: access.role,
      })
    })),

    get("/files/:id/download", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      const row = access.file

      const res = await fetchObject(store, row.storage_key)
      if (!res.body) return json(c, 500, { error: "Storage returned empty body" })

      const inline = new URL(c.request.url).searchParams.get("inline") === "1"
      const disposition = inline ? "inline" : `attachment; filename="${encodeURIComponent(row.name)}"`

      const withHeaders = putHeader(
        putHeader(
          putHeader(c, "content-type", row.mime),
          "content-disposition",
          disposition,
        ),
        "content-length",
        String(row.size),
      )
      return stream(withHeaders, 200, res.body)
    })),

    get("/files/:id/thumb", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await fileAccess(db, userId, id)
      if (!access || !access.file.thumb_key) return json(c, 404, { error: "No thumbnail" })

      const res = await fetchObject(store, access.file.thumb_key)
      if (!res.body) return json(c, 404, { error: "No thumbnail" })

      const withHeaders = putHeader(
        putHeader(c, "content-type", "image/webp"),
        "cache-control",
        "private, max-age=300",
      )
      return stream(withHeaders, 200, res.body)
    })),

    post("/files", upload(async (c) => {
      const userId = authId(c)
      const body = c.body as { fields: Record<string, string>; files: Record<string, Blob & { name?: string }> }
      if (!body || !body.files) return json(c, 422, { error: "No file uploaded" })

      const entries = Object.values(body.files)
      if (entries.length === 0) return json(c, 422, { error: "No file uploaded" })

      const folderRaw = body.fields?.folder_id ?? body.fields?.folderId
      const folderId = !folderRaw || folderRaw === "null" || folderRaw === "" ? null : Number(folderRaw)

      let ownerId = userId
      if (folderId != null) {
        const access = await folderAccess(db, userId, folderId)
        if (!access) return json(c, 404, { error: "Folder not found" })
        if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access to this folder" })
        ownerId = access.folder.user_id
      }

      const owner = await db.one(
        from("users").where(q => q("id").equals(ownerId)).select("storage_quota_bytes"),
      ) as { storage_quota_bytes: number | string } | null
      const quota = Number(owner?.storage_quota_bytes ?? 0)
      if (quota > 0) {
        const existingFiles = await db.all(
          from("files")
            .where(q => q("user_id").equals(ownerId))
            .where(q => q("deleted_at").isNull())
            .select("size"),
        ) as Array<{ size: number | string }>
        const used = existingFiles.reduce((acc, f) => acc + Number(f.size), 0)
        const incoming = entries.reduce((acc, f) => acc + (f.size ?? 0), 0)
        if (used + incoming > quota) {
          return json(c, 402, {
            error: "Storage quota exceeded",
            quota_bytes: quota,
            used_bytes: used,
            attempted_bytes: incoming,
          })
        }
      }

      const result: Array<{ id: number; name: string; mime: string; size: number; folder_id: number | null; version: number; created_at: string; new_version?: boolean }> = []

      for (const file of entries) {
        const name = (file as any).name ?? "upload.bin"
        const mime = file.type || "application/octet-stream"
        const size = file.size
        const key = makeKey(ownerId, name)
        await put(store, key, file, mime)

        let thumbKey: string | null = null
        if (isThumbable(mime)) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const thumb = await generateImageThumb(bytes, mime)
          if (thumb) {
            thumbKey = thumbKeyFor(key)
            try {
              await put(store, thumbKey, thumb, "image/webp")
            } catch {
              thumbKey = null
            }
          }
        }

        const existing = folderId === null
          ? await db.one(
              from("files")
                .where(q => q("user_id").equals(ownerId))
                .where(q => q("folder_id").isNull())
                .where(q => q("name").equals(name))
                .where(q => q("deleted_at").isNull()),
            ) as FileRow | null
          : await db.one(
              from("files")
                .where(q => q("user_id").equals(ownerId))
                .where(q => q("folder_id").equals(folderId))
                .where(q => q("name").equals(name))
                .where(q => q("deleted_at").isNull()),
            ) as FileRow | null

        if (existing) {
          const oldThumb = existing.thumb_key
          await archiveCurrent(db, existing, userId)
          const newVersion = existing.version + 1
          const rows = await db.execute(
            from("files")
              .where(q => q("id").equals(existing.id))
              .update({ mime, size, storage_key: key, thumb_key: thumbKey, version: newVersion })
              .returning("id", "name", "mime", "size", "folder_id", "version", "created_at"),
          )
          if (oldThumb) await Promise.allSettled([drop(store, oldThumb)])
          result.push({ ...rows[0], new_version: true } as any)
        } else {
          const rows = await db.execute(
            from("files")
              .insert({ user_id: ownerId, folder_id: folderId, name, mime, size, storage_key: key, thumb_key: thumbKey, version: 1 })
              .returning("id", "name", "mime", "size", "folder_id", "version", "created_at"),
          )
          result.push({ ...rows[0], new_version: false } as any)
        }
      }

      return json(c, 201, result)
    })),

    patch("/files/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const body = await c.request.json().catch(() => null) as any
      if (!body) return json(c, 422, { error: "Nothing to update" })

      const hasName = !!body.name
      const hasFolder = body.folder_id !== undefined || body.folderId !== undefined
      if (!hasName && !hasFolder) return json(c, 422, { error: "Nothing to update" })

      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })

      const patchData: Record<string, unknown> = {}
      if (hasName) patchData.name = String(body.name).trim()
      if (hasFolder) {
        const rawFid = body.folder_id !== undefined ? body.folder_id : body.folderId
        const fid = rawFid === null ? null : Number(rawFid)
        if (fid !== null) {
          const targetAccess = await folderAccess(db, userId, fid)
          if (!targetAccess) return json(c, 404, { error: "Target folder not found" })
          if (!canWrite(targetAccess.role)) return json(c, 403, { error: "No write access on target folder" })
          if (targetAccess.folder.user_id !== access.file.user_id) {
            return json(c, 422, { error: "Cannot move file across owners" })
          }
        } else {
          if (access.role !== "owner") return json(c, 403, { error: "Only the owner can move a file to the root" })
        }
        patchData.folder_id = fid
      }

      await db.execute(
        from("files").where(p => p("id").equals(id)).update(patchData),
      )

      return json(c, 200, { id, ...patchData })
    })),

    del("/files/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })

      await db.execute(
        from("files").where(p => p("id").equals(id)).update({ deleted_at: raw("NOW()") }),
      )

      return json(c, 200, { trashed: id })
    })),

    post("/files/:id/restore", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("files").where(p => p("id").equals(id)).where(p => p("user_id").equals(userId)),
      ) as FileRow | null
      if (!row) return json(c, 404, { error: "File not found" })
      if (!row.deleted_at) return json(c, 200, { id })

      let folderId = row.folder_id
      if (folderId != null) {
        const folder = await db.one(
          from("folders").where(q => q("id").equals(folderId)).where(q => q("deleted_at").isNull()),
        )
        if (!folder) folderId = null
      }

      await db.execute(
        from("files")
          .where(p => p("id").equals(id))
          .update({ deleted_at: null, folder_id: folderId }),
      )

      return json(c, 200, { restored: id, folder_id: folderId })
    })),

    del("/files/:id/purge", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("files").where(p => p("id").equals(id)).where(p => p("user_id").equals(userId)),
      ) as FileRow | null
      if (!row) return json(c, 404, { error: "File not found" })

      const versions = await db.all(
        from("file_versions").where(q => q("file_id").equals(id)).select("storage_key"),
      ) as Array<{ storage_key: string }>

      await db.execute(from("collaborations").where(q => q("resource_type").equals("file")).where(q => q("resource_id").equals(id)).del())
      await db.execute(from("shares").where(q => q("file_id").equals(id)).del())
      await db.execute(from("file_versions").where(q => q("file_id").equals(id)).del())
      await db.execute(from("files").where(q => q("id").equals(id)).del())

      await Promise.allSettled([
        drop(store, row.storage_key),
        ...(row.thumb_key ? [drop(store, row.thumb_key)] : []),
        ...versions.map(v => drop(store, v.storage_key)),
      ])

      return json(c, 200, { purged: id })
    })),

    get("/files/:id/versions", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      const file = access.file

      const prior = await db.all(
        from("file_versions")
          .where(q => q("file_id").equals(id))
          .select("version", "mime", "size", "uploaded_by", "uploaded_at")
          .orderBy("version", "DESC"),
      ) as Array<{ version: number; mime: string; size: number; uploaded_by: number | null; uploaded_at: string }>

      const current = {
        version: file.version,
        mime: file.mime,
        size: file.size,
        uploaded_at: file.created_at,
        is_current: true,
      }

      return json(c, 200, [current, ...prior.map(p => ({ ...p, is_current: false }))])
    })),

    get("/files/:id/versions/:version/download", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const version = Number(c.params.version)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      const file = access.file

      let meta: { mime: string; size: number; storage_key: string }
      if (version === file.version) {
        meta = { mime: file.mime, size: file.size, storage_key: file.storage_key }
      } else {
        const v = await db.one(
          from("file_versions").where(q => q("file_id").equals(id)).where(q => q("version").equals(version)),
        ) as { mime: string; size: number; storage_key: string } | null
        if (!v) return json(c, 404, { error: "Version not found" })
        meta = v
      }

      const res = await fetchObject(store, meta.storage_key)
      if (!res.body) return json(c, 500, { error: "Storage returned empty body" })

      const withHeaders = putHeader(
        putHeader(
          putHeader(c, "content-type", meta.mime),
          "content-disposition",
          `attachment; filename="${encodeURIComponent(file.name)}"`,
        ),
        "content-length",
        String(meta.size),
      )
      return stream(withHeaders, 200, res.body)
    })),

    post("/files/:id/versions/:version/restore", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const version = Number(c.params.version)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })
      const file = access.file
      if (version === file.version) return json(c, 422, { error: "Already the current version" })

      const target = await db.one(
        from("file_versions").where(q => q("file_id").equals(id)).where(q => q("version").equals(version)),
      ) as { id: number; version: number; mime: string; size: number; storage_key: string } | null
      if (!target) return json(c, 404, { error: "Version not found" })

      const oldThumb = file.thumb_key

      const restoredRes = await fetchObject(store, target.storage_key)
      const bytes = new Uint8Array(await restoredRes.arrayBuffer())

      let newThumbKey: string | null = null
      if (isThumbable(target.mime)) {
        const thumb = await generateImageThumb(bytes, target.mime)
        if (thumb) {
          newThumbKey = thumbKeyFor(target.storage_key)
          try {
            await put(store, newThumbKey, thumb, "image/webp")
          } catch {
            newThumbKey = null
          }
        }
      }

      await archiveCurrent(db, file, userId)

      const newVersion = file.version + 1
      await db.execute(
        from("files").where(q => q("id").equals(id)).update({
          mime: target.mime,
          size: target.size,
          storage_key: target.storage_key,
          thumb_key: newThumbKey,
          version: newVersion,
        }),
      )

      await db.execute(
        from("file_versions").where(q => q("id").equals(target.id)).del(),
      )

      if (oldThumb) await Promise.allSettled([drop(store, oldThumb)])

      return json(c, 200, { id, version: newVersion })
    })),

    del("/files/:id/versions/:version", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const version = Number(c.params.version)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })
      const file = access.file
      if (version === file.version) return json(c, 422, { error: "Cannot delete the current version" })

      const v = await db.one(
        from("file_versions").where(q => q("file_id").equals(id)).where(q => q("version").equals(version)),
      ) as { storage_key: string } | null
      if (!v) return json(c, 404, { error: "Version not found" })

      await db.execute(
        from("file_versions").where(q => q("file_id").equals(id)).where(q => q("version").equals(version)).del(),
      )
      await drop(store, v.storage_key)

      return json(c, 200, { deleted: version })
    })),
  ]
}

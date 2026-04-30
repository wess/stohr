import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseMultipart, patch, pipeline, post, putHeader, stream } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { drop, fetchObject, makeKey, put } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { generateImageThumb, isThumbable, THUMB_MAX_BYTES, thumbKeyFor } from "../storage/thumb.ts"
import { canWrite, fileAccess, folderAccess } from "../permissions/index.ts"
import type { FileRow, FolderRow } from "../permissions/index.ts"
import { checkQuota, computeUsage } from "../payments/usage.ts"
import { decideInline } from "../security/inline.ts"
import { fireEvent } from "../actions/dispatch.ts"
import type { RunSummary } from "../actions/dispatch.ts"

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
  const guard = pipeline(requireAuth({ secret, db }))
  const upload = pipeline(requireAuth({ secret, db }), parseMultipart)

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

      const wantInline = new URL(c.request.url).searchParams.get("inline") === "1"
      const { contentType, disposition } = decideInline(row.mime, row.name, wantInline)

      const withHeaders = putHeader(
        putHeader(
          putHeader(c, "content-type", contentType),
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
      let targetFolder: FolderRow | null = null
      if (folderId != null) {
        const access = await folderAccess(db, userId, folderId)
        if (!access) return json(c, 404, { error: "Folder not found" })
        if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access to this folder" })
        ownerId = access.folder.user_id
        targetFolder = access.folder
      }

      const owner = await db.one(
        from("users").where(q => q("id").equals(ownerId)).select("storage_quota_bytes"),
      ) as { storage_quota_bytes: number | string } | null
      const quota = Number(owner?.storage_quota_bytes ?? 0)
      const incoming = entries.reduce((acc, f) => acc + (f.size ?? 0), 0)
      const check = await checkQuota(db, ownerId, quota, incoming)
      if (!check.ok) {
        return json(c, 402, {
          error: "Storage quota exceeded",
          quota_bytes: check.quota_bytes,
          used_bytes: check.used_bytes,
          attempted_bytes: check.attempted_bytes,
          breakdown: check.breakdown,
        })
      }

      const result: Array<{ id: number; name: string; mime: string; size: number; folder_id: number | null; version: number; created_at: string; new_version?: boolean; action_results?: RunSummary[] }> = []
      // Rollback stack — pre-quota-check is racy under concurrent uploads, so
      // after every iteration we'll re-verify usage against the live DB. If
      // we've exceeded quota, every undo here is invoked in reverse order to
      // bring the user back below the limit.
      const undoStack: Array<() => Promise<void>> = []

      for (const file of entries) {
        const name = (file as any).name ?? "upload.bin"
        const mime = file.type || "application/octet-stream"
        const size = file.size
        const key = makeKey(ownerId, name)
        await put(store, key, file, mime)

        let thumbKey: string | null = null
        // Skip thumbnail generation for oversized images before we materialize
        // the full upload into a Buffer — generateImageThumb would reject the
        // bytes anyway, so don't waste the allocation.
        if (isThumbable(mime) && size <= THUMB_MAX_BYTES) {
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

        let fileId: number
        let isNewVersion: boolean
        if (existing) {
          const snapshot = { ...existing }
          await archiveCurrent(db, existing, userId)
          const newVersion = existing.version + 1
          await db.execute(
            from("files")
              .where(q => q("id").equals(existing.id))
              .update({ mime, size, storage_key: key, thumb_key: thumbKey, version: newVersion }),
          )
          if (snapshot.thumb_key) await Promise.allSettled([drop(store, snapshot.thumb_key)])
          fileId = existing.id
          isNewVersion = true
          undoStack.push(async () => {
            // Restore the row to its pre-upload values and discard the
            // file_versions archive entry we just created.
            await db.execute(
              from("file_versions")
                .where(q => q("file_id").equals(snapshot.id))
                .where(q => q("version").equals(snapshot.version))
                .del(),
            )
            await db.execute(
              from("files").where(q => q("id").equals(snapshot.id)).update({
                mime: snapshot.mime,
                size: snapshot.size,
                storage_key: snapshot.storage_key,
                thumb_key: snapshot.thumb_key,
                version: snapshot.version,
              }),
            )
            await Promise.allSettled([
              drop(store, key),
              ...(thumbKey ? [drop(store, thumbKey)] : []),
            ])
          })
        } else {
          const rows = await db.execute(
            from("files")
              .insert({ user_id: ownerId, folder_id: folderId, name, mime, size, storage_key: key, thumb_key: thumbKey, version: 1 })
              .returning("id"),
          ) as Array<{ id: number }>
          fileId = rows[0]!.id
          isNewVersion = false
          undoStack.push(async () => {
            await db.execute(from("files").where(q => q("id").equals(fileId)).del())
            await Promise.allSettled([
              drop(store, key),
              ...(thumbKey ? [drop(store, thumbKey)] : []),
            ])
          })
        }

        let actionResults: RunSummary[] = []
        if (targetFolder) {
          const fresh = await db.one(
            from("files").where(q => q("id").equals(fileId)),
          ) as FileRow | null
          if (fresh) {
            actionResults = await fireEvent({
              db,
              store,
              event: "file.created",
              folder: targetFolder,
              subject: { kind: "file", row: fresh },
              actor: { id: userId },
            })
          }
        }

        const after = await db.one(
          from("files")
            .where(q => q("id").equals(fileId))
            .select("id", "name", "mime", "size", "folder_id", "version", "created_at"),
        ) as { id: number; name: string; mime: string; size: number; folder_id: number | null; version: number; created_at: string } | null

        if (!after) continue
        const entry: typeof result[number] = { ...after, new_version: isNewVersion }
        if (actionResults.length > 0) entry.action_results = actionResults
        result.push(entry)
      }

      // Post-write quota verification — closes the TOCTOU window where two
      // concurrent uploads from the same user both pass the initial check.
      // Quota of 0 (unlimited) skips this entirely.
      if (quota > 0) {
        const finalUsage = await computeUsage(db, ownerId)
        if (finalUsage.total > quota) {
          for (const undo of undoStack.reverse()) {
            try { await undo() } catch (err) { console.error("[files] quota rollback failed:", err) }
          }
          return json(c, 402, {
            error: "Storage quota exceeded",
            quota_bytes: quota,
            used_bytes: finalUsage.total,
            attempted_bytes: incoming,
            breakdown: finalUsage,
          })
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

      const oldFolderId = access.file.folder_id
      let newFolderId: number | null = oldFolderId
      let targetFolder: FolderRow | null = null
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
          targetFolder = targetAccess.folder
        } else {
          if (access.role !== "owner") return json(c, 403, { error: "Only the owner can move a file to the root" })
        }
        patchData.folder_id = fid
        newFolderId = fid
      }

      await db.execute(
        from("files").where(p => p("id").equals(id)).update(patchData),
      )

      const updatedFile = await db.one(
        from("files").where(p => p("id").equals(id)),
      ) as FileRow | null

      const summaries: RunSummary[] = []
      if (updatedFile) {
        const moved = hasFolder && oldFolderId !== newFolderId
        if (moved) {
          if (oldFolderId != null) {
            const oldFolder = await db.one(
              from("folders").where(q => q("id").equals(oldFolderId)).where(q => q("deleted_at").isNull()),
            ) as FolderRow | null
            if (oldFolder) {
              summaries.push(...await fireEvent({
                db, store, event: "file.moved.out",
                folder: oldFolder, subject: { kind: "file", row: updatedFile },
                actor: { id: userId },
              }))
            }
          }
          if (targetFolder) {
            summaries.push(...await fireEvent({
              db, store, event: "file.moved.in",
              folder: targetFolder, subject: { kind: "file", row: updatedFile },
              actor: { id: userId },
            }))
          }
        } else if (hasName && updatedFile.folder_id != null) {
          const folder = await db.one(
            from("folders").where(q => q("id").equals(updatedFile.folder_id)).where(q => q("deleted_at").isNull()),
          ) as FolderRow | null
          if (folder) {
            summaries.push(...await fireEvent({
              db, store, event: "file.updated",
              folder, subject: { kind: "file", row: updatedFile },
              actor: { id: userId },
            }))
          }
        }
      }

      const out: Record<string, unknown> = { id, ...patchData }
      if (summaries.length > 0) out.action_results = summaries
      return json(c, 200, out)
    })),

    del("/files/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await fileAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "File not found" })
      if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access" })

      const file = access.file
      await db.execute(
        from("files").where(p => p("id").equals(id)).update({ deleted_at: raw("NOW()") }),
      )

      const summaries: RunSummary[] = []
      if (file.folder_id != null) {
        const folder = await db.one(
          from("folders").where(q => q("id").equals(file.folder_id)).where(q => q("deleted_at").isNull()),
        ) as FolderRow | null
        if (folder) {
          summaries.push(...await fireEvent({
            db, store, event: "file.deleted",
            folder, subject: { kind: "file", row: file },
            actor: { id: userId },
          }))
        }
      }

      const out: Record<string, unknown> = { trashed: id }
      if (summaries.length > 0) out.action_results = summaries
      return json(c, 200, out)
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

      const url = new URL(c.request.url)
      const rawLimit = Number(url.searchParams.get("limit") ?? 50)
      const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 200))
      const rawOffset = Number(url.searchParams.get("offset") ?? 0)
      const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)

      // Current version isn't in file_versions — surface it as the first
      // page item only.
      const includeCurrent = offset === 0
      const priorLimit = includeCurrent ? Math.max(0, limit - 1) : limit
      const priorOffset = includeCurrent ? 0 : offset - 1

      const prior = priorLimit > 0
        ? await db.all(
            from("file_versions")
              .where(q => q("file_id").equals(id))
              .select("version", "mime", "size", "uploaded_by", "uploaded_at")
              .orderBy("version", "DESC")
              .limit(priorLimit)
              .offset(priorOffset),
          ) as Array<{ version: number; mime: string; size: number; uploaded_by: number | null; uploaded_at: string }>
        : []

      const totalRow = await db.execute({
        text: "SELECT COUNT(*)::int AS n FROM file_versions WHERE file_id = $1",
        values: [id],
      }) as Array<{ n: number }>
      const total = (totalRow[0]?.n ?? 0) + 1

      const current = {
        version: file.version,
        mime: file.mime,
        size: file.size,
        uploaded_at: file.created_at,
        is_current: true,
      }
      const items = includeCurrent
        ? [current, ...prior.map(p => ({ ...p, is_current: false }))]
        : prior.map(p => ({ ...p, is_current: false }))

      return json(c, 200, { items, total, limit, offset })
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

      // Old versions are always served as attachments. We deliberately do
      // NOT echo the user-supplied mime back here — see security/inline.ts.
      const { contentType, disposition } = decideInline(meta.mime, file.name, false)
      const withHeaders = putHeader(
        putHeader(
          putHeader(c, "content-type", contentType),
          "content-disposition",
          disposition,
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

      // Only fetch + buffer the restored bytes when we actually need to
      // re-generate a thumbnail. For non-thumbable mimes (PDFs, archives,
      // video, etc.) restoring a multi-GB version no longer round-trips
      // the whole payload through API memory.
      let newThumbKey: string | null = null
      if (isThumbable(target.mime)) {
        const restoredRes = await fetchObject(store, target.storage_key)
        const bytes = new Uint8Array(await restoredRes.arrayBuffer())
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

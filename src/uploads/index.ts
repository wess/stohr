// Resumable chunked uploads. POST /files stays the path for small files; this
// module adds an init/chunk/status/finalize/abort flow for large ones.
//
// S3 backend: each chunk is an S3 UploadPart against a multipart upload created
// at init; finalize calls CompleteMultipartUpload.
// Local backend: each chunk is written as its own object (<key>.partN);
// finalize concatenates them into the final key and drops the parts.

import { randomBytes } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import type { FolderRow } from "../permissions/index.ts"
import { canWrite, folderAccess } from "../permissions/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop, fetchObject, makeKey, put } from "../storage/index.ts"
import { checkQuota } from "../usage/index.ts"
import { CHUNK_SIZE, SESSION_TTL_MS } from "./config.ts"
import { finalizeUpload } from "./finalize.ts"
import { abortMultipart, completeMultipart, initiateMultipart, isS3, type PartEtag, s3Store, uploadPart } from "./s3.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type SessionRow = {
  id: string
  user_id: number
  folder_id: number | null
  file_name: string
  total_size: number | string
  mime: string
  chunks_received: number | string
  byte_offset: number | string
  storage_key: string
  s3_upload_id: string | null
  s3_part_etags: string | null
  expires_at: string
  created_at: string
}

const newSessionId = () => randomBytes(18).toString("hex")

const partKey = (storageKey: string, part: number) => `${storageKey}.part${part}`

const parseEtags = (raw: string | null): PartEtag[] => {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as PartEtag[]) : []
  } catch {
    return []
  }
}

const statusOf = (s: SessionRow) => ({
  id: s.id,
  file_name: s.file_name,
  mime: s.mime,
  total_size: Number(s.total_size),
  chunk_size: CHUNK_SIZE,
  chunks_received: Number(s.chunks_received),
  offset: Number(s.byte_offset),
  folder_id: s.folder_id,
  expires_at: s.expires_at,
  complete: Number(s.byte_offset) >= Number(s.total_size),
})

const loadSession = async (db: Connection, id: string, userId: number) =>
  (await db.one(
    from("upload_sessions")
      .where(q => q("id").equals(id))
      .where(q => q("user_id").equals(userId)),
  )) as SessionRow | null

// Drops every staged artifact for a session (S3 multipart abort, or local
// part objects), then deletes the row. Tolerant of partial state.
const purgeSession = async (db: Connection, store: StorageHandle, s: SessionRow) => {
  if (s.s3_upload_id && isS3()) {
    try {
      await abortMultipart(s3Store(), s.storage_key, s.s3_upload_id)
    } catch (err) {
      console.error(`[uploads] abort multipart failed for ${s.id}:`, err)
    }
  } else if (!s.s3_upload_id) {
    const count = Number(s.chunks_received)
    await Promise.allSettled(Array.from({ length: count }, (_, i) => drop(store, partKey(s.storage_key, i + 1))))
  }
  await db.execute(
    from("upload_sessions")
      .where(q => q("id").equals(s.id))
      .del(),
  )
}

export const uploadRoutes = (db: Connection, store: StorageHandle, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    // Create a session. Validates quota up front against the declared total
    // size; for S3 it opens the multipart upload.
    post(
      "/files/upload/init",
      authed(async c => {
        const userId = authId(c)
        const body = (c.body ?? {}) as {
          file_name?: string
          fileName?: string
          name?: string
          total_size?: number | string
          totalSize?: number | string
          size?: number | string
          mime?: string
          folder_id?: number | string | null
          folderId?: number | string | null
        }

        const name = (body.file_name ?? body.fileName ?? body.name ?? "").toString().trim()
        if (!name) return json(c, 422, { error: "file_name is required" })

        const totalRaw = body.total_size ?? body.totalSize ?? body.size
        const totalSize = Number(totalRaw)
        if (!Number.isFinite(totalSize) || totalSize <= 0) {
          return json(c, 422, { error: "total_size must be a positive number" })
        }

        const mime = (body.mime ?? "application/octet-stream").toString()
        const folderRaw = body.folder_id ?? body.folderId
        const folderId =
          folderRaw === null || folderRaw === undefined || folderRaw === "" || folderRaw === "null"
            ? null
            : Number(folderRaw)

        let ownerId = userId
        let targetFolder: FolderRow | null = null
        if (folderId != null) {
          const access = await folderAccess(db, userId, folderId)
          if (!access) return json(c, 404, { error: "Folder not found" })
          if (!canWrite(access.role)) return json(c, 403, { error: "Read-only access to this folder" })
          ownerId = access.folder.user_id
          targetFolder = access.folder
        }

        const owner = (await db.one(
          from("users")
            .where(q => q("id").equals(ownerId))
            .select("storage_quota_bytes"),
        )) as { storage_quota_bytes: number | string } | null
        const quota = Number(owner?.storage_quota_bytes ?? 0)
        const check = await checkQuota(db, ownerId, quota, totalSize)
        if (!check.ok) {
          return json(c, 402, {
            error: "Storage quota exceeded",
            quota_bytes: check.quota_bytes,
            used_bytes: check.used_bytes,
            attempted_bytes: check.attempted_bytes,
            breakdown: check.breakdown,
          })
        }

        const id = newSessionId()
        const key = makeKey(ownerId, name)
        let s3UploadId: string | null = null
        if (isS3()) {
          s3UploadId = await initiateMultipart(s3Store(), key, mime)
        }

        const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
        await db.execute(
          from("upload_sessions").insert({
            id,
            user_id: ownerId,
            folder_id: folderId,
            file_name: name,
            total_size: totalSize,
            mime,
            chunks_received: 0,
            byte_offset: 0,
            storage_key: key,
            s3_upload_id: s3UploadId,
            s3_part_etags: "[]",
            expires_at: expiresAt,
          }),
        )

        // Echo folder ownership note so callers know which owner the file
        // will land under (relevant for shared folders).
        return json(c, 201, {
          id,
          chunk_size: CHUNK_SIZE,
          total_size: totalSize,
          chunks_expected: Math.ceil(totalSize / CHUNK_SIZE),
          expires_at: expiresAt,
          folder_id: folderId,
          owner_id: targetFolder ? ownerId : userId,
        })
      }),
    ),

    // Upload one part. Body is the raw chunk bytes. Part number is 1-based and
    // must be the next expected part (chunks_received + 1) — we require strict
    // ordering so offset bookkeeping stays simple and resumable.
    post(
      "/files/upload/:id/chunk",
      guard(async c => {
        const userId = authId(c)
        const s = await loadSession(db, c.params.id, userId)
        if (!s) return json(c, 404, { error: "Upload session not found" })
        if (new Date(s.expires_at).getTime() < Date.now()) {
          return json(c, 410, { error: "Upload session expired" })
        }

        const received = Number(s.chunks_received)
        const url = new URL(c.request.url)
        const partRaw = url.searchParams.get("part") ?? url.searchParams.get("partNumber")
        const part = partRaw === null ? received + 1 : Number(partRaw)
        if (!Number.isInteger(part) || part < 1) {
          return json(c, 422, { error: "Invalid part number" })
        }
        // Idempotent re-PUT of the part we already have is a no-op success so a
        // client retrying a flaky chunk doesn't error out.
        if (part <= received) return json(c, 200, statusOf(s))
        if (part !== received + 1) {
          return json(c, 409, { error: `Out of order chunk: expected part ${received + 1}, got ${part}` })
        }

        const bytes = new Uint8Array(await c.request.arrayBuffer())
        if (bytes.length === 0) return json(c, 422, { error: "Empty chunk" })

        const total = Number(s.total_size)
        const newOffset = Number(s.byte_offset) + bytes.length
        if (newOffset > total) {
          return json(c, 422, { error: "Chunk exceeds declared total_size" })
        }
        const isLast = newOffset >= total
        // Every part except the last must be exactly CHUNK_SIZE — both to keep
        // offsets predictable for resume and to satisfy the S3 5MB minimum.
        if (!isLast && bytes.length !== CHUNK_SIZE) {
          return json(c, 422, { error: `Non-final chunk must be exactly ${CHUNK_SIZE} bytes` })
        }

        let etags = parseEtags(s.s3_part_etags)
        if (s.s3_upload_id && isS3()) {
          const etag = await uploadPart(s3Store(), s.storage_key, s.s3_upload_id, part, bytes)
          etags = [...etags, { part, etag }]
        } else {
          await put(store, partKey(s.storage_key, part), bytes, "application/octet-stream")
        }

        await db.execute(
          from("upload_sessions")
            .where(q => q("id").equals(s.id))
            .update({
              chunks_received: part,
              byte_offset: newOffset,
              s3_part_etags: JSON.stringify(etags),
            }),
        )

        const updated = { ...s, chunks_received: part, byte_offset: newOffset }
        return json(c, 200, statusOf(updated))
      }),
    ),

    get(
      "/files/upload/:id/status",
      guard(async c => {
        const userId = authId(c)
        const s = await loadSession(db, c.params.id, userId)
        if (!s) return json(c, 404, { error: "Upload session not found" })
        return json(c, 200, statusOf(s))
      }),
    ),

    // Assemble the object and create the files row. Requires every byte to
    // have arrived first.
    post(
      "/files/upload/:id/finalize",
      guard(async c => {
        const userId = authId(c)
        const s = await loadSession(db, c.params.id, userId)
        if (!s) return json(c, 404, { error: "Upload session not found" })
        if (new Date(s.expires_at).getTime() < Date.now()) {
          return json(c, 410, { error: "Upload session expired" })
        }

        const total = Number(s.total_size)
        if (Number(s.byte_offset) < total) {
          return json(c, 409, {
            error: "Upload incomplete",
            offset: Number(s.byte_offset),
            total_size: total,
          })
        }

        let thumbBytes: Uint8Array | null = null

        if (s.s3_upload_id && isS3()) {
          const etags = parseEtags(s.s3_part_etags)
          await completeMultipart(s3Store(), s.storage_key, s.s3_upload_id, etags)
          // Object now lives at storage_key. We skip thumbnailing rather than
          // re-download a freshly assembled object — same tradeoff finalize.ts
          // documents.
        } else {
          // Local concat: read each part in order into the final key.
          const count = Number(s.chunks_received)
          const buffers: Uint8Array[] = []
          for (let i = 1; i <= count; i++) {
            const res = await fetchObject(store, partKey(s.storage_key, i))
            buffers.push(new Uint8Array(await res.arrayBuffer()))
          }
          const totalLen = buffers.reduce((n, b) => n + b.length, 0)
          const merged = new Uint8Array(totalLen)
          let off = 0
          for (const b of buffers) {
            merged.set(b, off)
            off += b.length
          }
          await put(store, s.storage_key, merged, s.mime)
          await Promise.allSettled(buffers.map((_, i) => drop(store, partKey(s.storage_key, i + 1))))
          thumbBytes = merged
        }

        const result = await finalizeUpload(db, store, {
          ownerId: s.user_id,
          folderId: s.folder_id,
          name: s.file_name,
          mime: s.mime,
          size: total,
          key: s.storage_key,
          thumbBytes,
        })

        await db.execute(
          from("upload_sessions")
            .where(q => q("id").equals(s.id))
            .del(),
        )

        return json(c, 201, result)
      }),
    ),

    del(
      "/files/upload/:id",
      guard(async c => {
        const userId = authId(c)
        const s = await loadSession(db, c.params.id, userId)
        if (!s) return json(c, 404, { error: "Upload session not found" })
        await purgeSession(db, store, s)
        return json(c, 200, { aborted: s.id })
      }),
    ),
  ]
}

// Sweep: abort + delete every session past its TTL. Registered on setInterval
// by src/server.ts (see integration notes). Guarded against self-stacking by
// the caller's guardedSweep wrapper.
export const cleanupExpiredUploads = async (db: Connection, store: StorageHandle): Promise<void> => {
  const expired = (await db.all(
    from("upload_sessions").where(q => q("expires_at").lessThan(raw("NOW()"))),
  )) as SessionRow[]
  for (const s of expired) {
    try {
      await purgeSession(db, store, s)
    } catch (err) {
      console.error(`[uploads] cleanup failed for ${s.id}:`, err)
    }
  }
}
